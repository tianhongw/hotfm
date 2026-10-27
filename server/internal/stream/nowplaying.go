package stream

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"hotfm/server/internal/store"
)

const (
	// watchLingerDefault keeps the upstream connection open after the last
	// subscriber leaves, so a quick reload does not reconnect.
	watchLingerDefault = 15 * time.Second
	// noMetaTTLDefault is how long a station without ICY metadata is remembered
	// so it is not re-probed for every listener.
	noMetaTTLDefault = 10 * time.Minute
	watchBackoffMin  = time.Second
	watchBackoffMax  = 30 * time.Second
)

// ErrNoCapacity is returned when the global metadata watcher cap is reached.
var ErrNoCapacity = errors.New("metadata watcher capacity reached")

// errNotIcy reports an upstream that will never carry ICY metadata (HLS,
// HTML error page, or no icy-metaint header).
type errNotIcy struct{ reason string }

func (e errNotIcy) Error() string { return "upstream has no ICY metadata: " + e.reason }

// NowPlaying fans "now playing" titles out to every listener of a station over
// one shared, metadata-only upstream connection per station. It is used for
// direct (non-proxied) audio streams, where the browser cannot read ICY
// metadata itself; proxied streams keep using Hub, keyed by session.
//
// A watcher is started on the first subscriber and cancelled Linger after the
// last one leaves. Stations whose upstream has no ICY metadata are cached as
// negative for NoMetaTTL, so listening to them costs one probe, not one
// connection per listener.
type NowPlaying struct {
	Client      *http.Client
	UserAgent   string
	Log         *slog.Logger
	MaxWatchers int           // <=0 = unlimited
	Linger      time.Duration // 0 => watchLingerDefault
	NoMetaTTL   time.Duration // 0 => noMetaTTLDefault

	mu       sync.Mutex
	stations map[string]*npEntry
	negative map[string]time.Time
	running  int
}

type npEntry struct {
	subs   map[chan string]struct{}
	title  string
	cancel context.CancelFunc
	stop   *time.Timer
}

func NewNowPlaying(client *http.Client, ua string, log *slog.Logger, maxWatchers int) *NowPlaying {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &NowPlaying{
		Client:      client,
		UserAgent:   ua,
		Log:         log,
		MaxWatchers: maxWatchers,
		stations:    map[string]*npEntry{},
		negative:    map[string]time.Time{},
	}
}

func (n *NowPlaying) linger() time.Duration {
	if n.Linger > 0 {
		return n.Linger
	}
	return watchLingerDefault
}

func (n *NowPlaying) noMetaTTL() time.Duration {
	if n.NoMetaTTL > 0 {
		return n.NoMetaTTL
	}
	return noMetaTTLDefault
}

// Subscribe registers for title updates of a station, starting a watcher if
// none is running. The returned current title is the latest known one (empty
// if unknown or negative-cached). release must be called exactly once and is
// safe to call from any goroutine.
func (n *NowPlaying) Subscribe(st *store.Station) (<-chan string, string, func(), error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.stations == nil {
		n.stations = map[string]*npEntry{}
	}
	if n.negative == nil {
		n.negative = map[string]time.Time{}
	}
	id := st.ID
	e := n.stations[id]
	if until, ok := n.negative[id]; ok {
		if time.Now().Before(until) {
			// Known to have no metadata: subscribe without a watcher and no title.
			if e == nil {
				e = &npEntry{subs: map[chan string]struct{}{}}
				n.stations[id] = e
			}
			ch := n.addSub(e)
			return ch, "", n.releaseFunc(id, e, ch), nil
		}
		delete(n.negative, id)
	}
	if e == nil {
		e = &npEntry{subs: map[chan string]struct{}{}}
		n.stations[id] = e
	}
	if e.cancel == nil {
		if n.MaxWatchers > 0 && n.running >= n.MaxWatchers {
			if len(e.subs) == 0 && n.stations[id] == e {
				delete(n.stations, id)
			}
			return nil, "", nil, ErrNoCapacity
		}
		ctx, cancel := context.WithCancel(context.Background())
		e.cancel = cancel
		n.running++
		go n.watch(ctx, st, e)
	}
	if e.stop != nil {
		e.stop.Stop()
		e.stop = nil
	}
	ch := n.addSub(e)
	return ch, e.title, n.releaseFunc(id, e, ch), nil
}

// addSub registers a new subscriber channel; callers hold n.mu.
func (n *NowPlaying) addSub(e *npEntry) chan string {
	ch := make(chan string, 4)
	e.subs[ch] = struct{}{}
	return ch
}

// releaseFunc returns an idempotent unsubscribe that schedules the linger stop.
func (n *NowPlaying) releaseFunc(id string, e *npEntry, ch chan string) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			n.mu.Lock()
			defer n.mu.Unlock()
			delete(e.subs, ch)
			if len(e.subs) == 0 {
				if e.stop != nil {
					e.stop.Stop()
				}
				e.stop = time.AfterFunc(n.linger(), func() { n.stopIfIdle(id, e) })
			}
		})
	}
}

// stopIfIdle cancels a watcher whose subscribers all left during the linger
// window; a subscriber that arrived meanwhile keeps it alive.
func (n *NowPlaying) stopIfIdle(id string, e *npEntry) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if len(e.subs) != 0 {
		return
	}
	e.stop = nil
	if e.cancel != nil {
		e.cancel()
		return
	}
	// Negative-cached station: no watcher will ever clean this entry up.
	if n.stations[id] == e {
		delete(n.stations, id)
	}
}

// watch pumps titles from the upstream until ctx is cancelled, caching
// "no ICY metadata" upstreams and backing off after failures.
func (n *NowPlaying) watch(ctx context.Context, st *store.Station, e *npEntry) {
	id := st.ID
	backoff := watchBackoffMin
	defer func() {
		n.mu.Lock()
		e.cancel = nil
		n.running--
		var restart context.Context
		var cancel context.CancelFunc
		if len(e.subs) == 0 {
			if n.stations[id] == e {
				delete(n.stations, id)
			}
		} else {
			// Subscribers arrived while the watcher was stopping: keep them warm.
			restart, cancel = context.WithCancel(context.Background())
			e.cancel = cancel
			n.running++
		}
		n.mu.Unlock()
		if restart != nil {
			go n.watch(restart, st, e)
		}
	}()

	for ctx.Err() == nil {
		err := n.readOnce(ctx, st, func(t string) {
			n.mu.Lock()
			e.title = t
			for ch := range e.subs {
				select {
				case ch <- t:
				default: // slow subscriber; it will get the next title
				}
			}
			n.mu.Unlock()
			backoff = watchBackoffMin
		})
		if ctx.Err() != nil {
			return
		}
		var noMeta errNotIcy
		if errors.As(err, &noMeta) {
			ttl := n.noMetaTTL()
			deadline := time.Now().Add(ttl)
			n.mu.Lock()
			if n.negative == nil {
				n.negative = map[string]time.Time{}
			}
			n.negative[id] = deadline
			n.mu.Unlock()
			n.Log.Info("nowplaying: upstream has no ICY metadata", "station", id, "reason", noMeta.reason)
			t := time.NewTimer(time.Until(deadline))
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-t.C:
			}
			continue
		}
		n.Log.Debug("nowplaying: upstream ended", "station", id, "err", err)
		t := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		if backoff *= 2; backoff > watchBackoffMax {
			backoff = watchBackoffMax
		}
	}
}

// readOnce opens the station stream without relaying audio, feeding every ICY
// title to onTitle. It returns errNotIcy for upstreams that never carry
// metadata and stops after idleTimeout without data.
func (n *NowPlaying) readOnce(ctx context.Context, st *store.Station, onTitle func(string)) error {
	attemptCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	idle := time.AfterFunc(idleTimeout, cancel)
	defer idle.Stop()

	req, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, st.StreamURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", n.UserAgent)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Icy-MetaData", "1")
	resp, err := n.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}

	ctype := resp.Header.Get("Content-Type")
	head := make([]byte, 512)
	nread, rerr := io.ReadAtLeast(resp.Body, head, 1)
	head = head[:nread]
	if rerr != nil {
		// Empty or unreadable response: retry with backoff rather than
		// remembering the station as "no metadata".
		return rerr
	}
	if IsPlaylist(ctype, head) {
		return errNotIcy{reason: "is_hls"}
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(ctype)), "text/html") {
		return errNotIcy{reason: "not_audio"}
	}
	mi, _ := strconv.Atoi(resp.Header.Get("icy-metaint"))
	if mi <= 0 {
		return errNotIcy{reason: "no_metaint"}
	}
	mr := &MetaReader{
		R:         &idleReset{r: io.MultiReader(bytes.NewReader(head), resp.Body), t: idle},
		MetaInt:   mi,
		PreferGBK: st.Country == "CN",
		OnTitle:   onTitle,
	}
	_, err = io.Copy(io.Discard, mr)
	return err
}

// idleReset postpones the idle abort while the upstream keeps delivering.
type idleReset struct {
	r io.Reader
	t *time.Timer
}

func (r *idleReset) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	if n > 0 {
		r.t.Reset(idleTimeout)
	}
	return n, err
}

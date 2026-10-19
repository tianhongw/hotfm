package stream

import (
	"sync"
	"time"
)

// Hub routes "now playing" titles from an audio proxy connection to the SSE
// subscribers of the same listening session (sid).
type Hub struct {
	mu     sync.Mutex
	topics map[string]*topic
}

type topic struct {
	title   string
	subs    map[chan string]struct{}
	touched time.Time
}

func NewHub() *Hub {
	return &Hub{topics: map[string]*topic{}}
}

func (h *Hub) get(sid string) *topic {
	t := h.topics[sid]
	if t == nil {
		t = &topic{subs: map[chan string]struct{}{}}
		h.topics[sid] = t
	}
	t.touched = time.Now()
	return t
}

func (h *Hub) Publish(sid, title string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.get(sid)
	t.title = title
	for ch := range t.subs {
		select {
		case ch <- title:
		default: // slow subscriber; it will get the next title
		}
	}
}

// Subscribe returns a channel of title updates plus the latest known title.
func (h *Hub) Subscribe(sid string) (<-chan string, string, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.get(sid)
	ch := make(chan string, 4)
	t.subs[ch] = struct{}{}
	return ch, t.title, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		delete(t.subs, ch)
		t.touched = time.Now()
	}
}

// Sweep drops idle sessions; call it periodically.
func (h *Hub) Sweep(idle time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sid, t := range h.topics {
		if len(t.subs) == 0 && time.Since(t.touched) > idle {
			delete(h.topics, sid)
		}
	}
}

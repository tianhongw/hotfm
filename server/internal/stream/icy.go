// Package stream proxies radio streams to browsers: Icecast/Shoutcast audio
// with in-band metadata stripped and published, and HLS with rewritten
// playlists. Proxying fixes mixed content (http streams on an https site),
// CORS for Web Audio and lets the server read "now playing" titles.
package stream

import (
	"bytes"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/simplifiedchinese"
)

// MetaReader yields only audio bytes from an ICY stream with icy-metaint
// set, calling OnTitle when the StreamTitle changes.
type MetaReader struct {
	R       io.Reader
	MetaInt int
	OnTitle func(string)
	// PreferGBK decodes non-UTF-8 titles as GB18030 first (Chinese stations), else Latin-1.
	PreferGBK bool

	left  int
	init  bool
	title string
	lenb  [1]byte
	meta  []byte
}

func (m *MetaReader) Read(p []byte) (int, error) {
	if !m.init {
		m.init, m.left = true, m.MetaInt
	}
	if m.left == 0 {
		if _, err := io.ReadFull(m.R, m.lenb[:]); err != nil {
			return 0, err
		}
		if n := int(m.lenb[0]) * 16; n > 0 {
			if cap(m.meta) < n {
				m.meta = make([]byte, n)
			}
			m.meta = m.meta[:n]
			if _, err := io.ReadFull(m.R, m.meta); err != nil {
				return 0, err
			}
			if t, ok := ParseStreamTitle(m.meta, m.PreferGBK); ok && t != m.title {
				m.title = t
				if m.OnTitle != nil {
					m.OnTitle(t)
				}
			}
		}
		m.left = m.MetaInt
	}
	if len(p) > m.left {
		p = p[:m.left]
	}
	n, err := m.R.Read(p)
	m.left -= n
	return n, err
}

var reStreamTitle = regexp.MustCompile(`(?s)StreamTitle='(.*?)';`)

// ParseStreamTitle extracts and decodes StreamTitle from an ICY metadata block.
func ParseStreamTitle(block []byte, preferGBK bool) (string, bool) {
	block = bytes.TrimRight(block, "\x00")
	m := reStreamTitle.FindSubmatch(block)
	if m == nil {
		// Some servers omit the trailing ';'.
		if i := bytes.Index(block, []byte("StreamTitle='")); i >= 0 {
			rest := block[i+len("StreamTitle='"):]
			if j := bytes.LastIndexByte(rest, '\''); j >= 0 {
				m = [][]byte{nil, rest[:j]}
			}
		}
		if m == nil {
			return "", false
		}
	}
	return strings.TrimSpace(decodeText(m[1], preferGBK)), true
}

func decodeText(b []byte, preferGBK bool) string {
	if utf8.Valid(b) {
		return string(b)
	}
	if preferGBK {
		if s, err := simplifiedchinese.GB18030.NewDecoder().Bytes(b); err == nil && !bytes.ContainsRune(s, utf8.RuneError) {
			return string(s)
		}
	}
	s, _ := charmap.ISO8859_1.NewDecoder().Bytes(b)
	return string(s)
}

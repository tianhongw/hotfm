package stream

import (
	"bytes"
	"io"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func metaBlock(s string) []byte {
	n := (len(s) + 15) / 16
	b := make([]byte, 1+n*16)
	b[0] = byte(n)
	copy(b[1:], s)
	return b
}

func TestMetaReaderStripsMetadata(t *testing.T) {
	const metaint = 8
	var src bytes.Buffer
	src.WriteString("AAAAAAAA")
	src.Write(metaBlock("StreamTitle='Artist - Song';"))
	src.WriteString("BBBBBBBB")
	src.WriteByte(0) // empty metadata block
	src.WriteString("CCCC")

	var titles []string
	r := &MetaReader{R: &src, MetaInt: metaint, OnTitle: func(s string) { titles = append(titles, s) }}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "AAAAAAAABBBBBBBBCCCC" {
		t.Fatalf("audio = %q", out)
	}
	if len(titles) != 1 || titles[0] != "Artist - Song" {
		t.Fatalf("titles = %q", titles)
	}
}

func TestParseStreamTitleEncodings(t *testing.T) {
	gbk, _ := simplifiedchinese.GBK.NewEncoder().Bytes([]byte("周杰伦 - 晴天"))
	cases := []struct {
		block []byte
		gbk   bool
		want  string
	}{
		{[]byte("StreamTitle='Daft Punk - One More Time';StreamUrl='';"), false, "Daft Punk - One More Time"},
		{[]byte("StreamTitle='It''s Me';"), false, "It''s Me"},
		{append(append([]byte("StreamTitle='"), gbk...), []byte("';\x00\x00")...), true, "周杰伦 - 晴天"},
		{[]byte("StreamTitle='Beyonc\xe9 - Halo';"), false, "Beyoncé - Halo"},
		{[]byte("StreamTitle='No terminator'"), false, "No terminator"},
	}
	for _, c := range cases {
		got, ok := ParseStreamTitle(c.block, c.gbk)
		if !ok || got != c.want {
			t.Errorf("ParseStreamTitle(%q) = %q, %v; want %q", c.block, got, ok, c.want)
		}
	}
}

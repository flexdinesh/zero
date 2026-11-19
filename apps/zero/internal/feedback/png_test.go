package feedback

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

// testPNG encodes a width×height image.
func testPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	picture := image.NewNRGBA(image.Rect(0, 0, width, height))
	for x := range width {
		picture.Set(x, 0, color.NRGBA{R: uint8(x), A: 255})
	}
	var out bytes.Buffer
	if err := png.Encode(&out, picture); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// pngChunk encodes one chunk with its CRC.
func pngChunk(kind string, data []byte) []byte {
	chunk := binary.BigEndian.AppendUint32(nil, uint32(len(data)))
	chunk = append(chunk, kind...)
	chunk = append(chunk, data...)
	return binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(chunk[4:]))
}

// withChunks inserts chunks right after IHDR.
func withChunks(data []byte, chunks ...[]byte) []byte {
	const afterHeader = 8 + 25
	out := append([]byte{}, data[:afterHeader]...)
	for _, chunk := range chunks {
		out = append(out, chunk...)
	}
	return append(out, data[afterHeader:]...)
}

func TestCleanPNGDropsMetadataChunks(t *testing.T) {
	plain := testPNG(t, 12, 7)
	tagged := withChunks(plain,
		pngChunk("tEXt", []byte("Author\x00Jane")),
		pngChunk("zTXt", []byte("k\x00\x00x")),
		pngChunk("iTXt", []byte("k\x00\x00\x00\x00\x00v")),
		pngChunk("eXIf", []byte("MM\x00*")),
		pngChunk("tIME", []byte{7, 234, 11, 19, 12, 0, 0}),
		pngChunk("pHYs", []byte{0, 0, 11, 19, 0, 0, 11, 19, 1}),
	)
	tagged = append(tagged, []byte("trailing secrets")...)
	cleaned, width, height, err := CleanPNG(tagged)
	if err != nil || width != 12 || height != 7 {
		t.Fatalf("CleanPNG = %d×%d, %v", width, height, err)
	}
	if want := withChunks(plain, pngChunk("pHYs", []byte{0, 0, 11, 19, 0, 0, 11, 19, 1})); !bytes.Equal(cleaned, want) {
		t.Errorf("CleanPNG kept %q, want only pHYs added to the plain PNG", cleaned)
	}
	if _, err := png.Decode(bytes.NewReader(cleaned)); err != nil {
		t.Errorf("cleaned PNG doesn't decode: %v", err)
	}
	if again, _, _, err := CleanPNG(plain); err != nil || !bytes.Equal(again, plain) {
		t.Errorf("CleanPNG of a clean PNG changed it: %v", err)
	}
}

func TestCleanPNGRejects(t *testing.T) {
	plain := testPNG(t, 4, 4)
	corrupt := append([]byte{}, plain...)
	corrupt[len(corrupt)-20] ^= 0xff
	headerWith := func(body []byte) []byte {
		out := append([]byte{}, pngSignature...)
		out = append(out, pngChunk("IHDR", body)...)
		return append(out, plain[8+25:]...)
	}
	header := func(width, height uint32) []byte {
		body := binary.BigEndian.AppendUint32(nil, width)
		body = binary.BigEndian.AppendUint32(body, height)
		return headerWith(append(body, 8, 6, 0, 0, 0))
	}
	noData := append(append([]byte{}, plain[:8+25]...), pngChunk("IEND", nil)...)
	for name, test := range map[string]struct {
		data []byte
		want string
	}{
		"not a PNG":      {[]byte("GIF89a"), "not a PNG"},
		"bad CRC":        {corrupt, "fails its CRC"},
		"truncated":      {plain[:len(plain)-6], "ends inside a chunk"},
		"no IEND":        {plain[:len(plain)-12], "ends inside a chunk"},
		"too wide":       {header(MaxImageSide+1, 1), "each side must be at most 8192 px"},
		"too many px":    {header(8192, 2049), "its area must be at most 16 MP"},
		"empty":          {header(0, 1), "the image is empty"},
		"no image data":  {noData, "no image data"},
		"chunk before":   {append(append([]byte{}, pngSignature...), append(pngChunk("tEXt", []byte("a\x00b")), plain[8:]...)...), "doesn't start with IHDR"},
		"invalid fields": {headerWith([]byte{0, 0, 0, 1, 0, 0, 0, 1, 3, 6, 0, 0, 0}), "invalid fields"},
	} {
		_, _, _, err := CleanPNG(test.data)
		if !errors.Is(err, ErrInvalidImage) || !strings.Contains(err.Error(), test.want) {
			t.Errorf("CleanPNG(%s) = %v, want ErrInvalidImage with %q", name, err, test.want)
		}
	}
	if _, width, height, err := CleanPNG(header(4096, 4096)); err != nil || width != 4096 || height != 4096 {
		t.Errorf("CleanPNG(4096×4096) = %d×%d, %v; 16 MP fits", width, height, err)
	}
}

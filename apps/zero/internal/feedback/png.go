package feedback

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
)

// Image bounds for attachments (decision 0176).
const (
	// MaxImageSide bounds an attachment's width and height, in pixels.
	MaxImageSide = 8192
	// MaxImagePixels bounds an attachment's area: 16 MP (16 × 2^20 pixels,
	// so 4096×4096 fits).
	MaxImagePixels = 16 << 20
)

// MediaTypePNG is the one media type attachments are stored as.
const MediaTypePNG = "image/png"

// ErrInvalidImage wraps an upload that is not a PNG zero stores.
var ErrInvalidImage = errors.New("invalid image")

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

// strippedChunks are the ancillary metadata chunks dropped from every
// attachment.
var strippedChunks = map[string]bool{"tEXt": true, "zTXt": true, "iTXt": true, "eXIf": true, "tIME": true}

// CleanPNG checks data at the chunk level without decoding pixels: the PNG
// signature, every chunk's CRC, an IHDR first whose size is within
// MaxImageSide and MaxImagePixels, at least one IDAT, and an IEND. It
// returns the PNG without its metadata chunks or anything after IEND, and
// the image's size. Errors wrap ErrInvalidImage.
func CleanPNG(data []byte) (cleaned []byte, width, height int, err error) {
	if !bytes.HasPrefix(data, pngSignature) {
		return nil, 0, 0, fmt.Errorf("%w: not a PNG", ErrInvalidImage)
	}
	out := bytes.NewBuffer(make([]byte, 0, len(data)))
	out.Write(pngSignature)
	rest := data[len(pngSignature):]
	seenIDAT := false
	for index := 0; ; index++ {
		if len(rest) < 12 {
			return nil, 0, 0, fmt.Errorf("%w: the PNG ends inside a chunk", ErrInvalidImage)
		}
		length := binary.BigEndian.Uint32(rest)
		if uint64(length) > uint64(len(rest)-12) {
			return nil, 0, 0, fmt.Errorf("%w: the PNG ends inside a chunk", ErrInvalidImage)
		}
		chunk := rest[:12+int(length)]
		kind := string(chunk[4:8])
		body := chunk[8 : 8+length]
		if !chunkName(kind) {
			return nil, 0, 0, fmt.Errorf("%w: chunk %d has an invalid type", ErrInvalidImage, index+1)
		}
		if crc32.ChecksumIEEE(chunk[4:8+length]) != binary.BigEndian.Uint32(chunk[8+length:]) {
			return nil, 0, 0, fmt.Errorf("%w: chunk %s fails its CRC", ErrInvalidImage, kind)
		}
		rest = rest[len(chunk):]
		switch {
		case index == 0 && kind != "IHDR":
			return nil, 0, 0, fmt.Errorf("%w: the PNG doesn't start with IHDR", ErrInvalidImage)
		case index == 0:
			if width, height, err = headerSize(body); err != nil {
				return nil, 0, 0, err
			}
		case kind == "IHDR":
			return nil, 0, 0, fmt.Errorf("%w: the PNG has a second IHDR", ErrInvalidImage)
		case kind == "IDAT":
			seenIDAT = true
		}
		if strippedChunks[kind] {
			continue
		}
		out.Write(chunk)
		if kind == "IEND" {
			break
		}
	}
	if !seenIDAT {
		return nil, 0, 0, fmt.Errorf("%w: the PNG has no image data", ErrInvalidImage)
	}
	return out.Bytes(), width, height, nil
}

// headerSize reads and bounds an IHDR body's size, checking its fields.
func headerSize(body []byte) (int, int, error) {
	if len(body) != 13 {
		return 0, 0, fmt.Errorf("%w: IHDR is %d bytes, not 13", ErrInvalidImage, len(body))
	}
	width, height := binary.BigEndian.Uint32(body), binary.BigEndian.Uint32(body[4:])
	depth, color, compression, filter, interlace := body[8], body[9], body[10], body[11], body[12]
	depths := map[byte][]byte{0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
	allowed, known := depths[color]
	if !known || !bytes.Contains(allowed, []byte{depth}) || compression != 0 || filter != 0 || interlace > 1 {
		return 0, 0, fmt.Errorf("%w: IHDR has invalid fields", ErrInvalidImage)
	}
	switch {
	case width < 1 || height < 1:
		return 0, 0, fmt.Errorf("%w: the image is empty", ErrInvalidImage)
	case width > MaxImageSide || height > MaxImageSide:
		return 0, 0, fmt.Errorf("%w: the image is %d×%d; each side must be at most %d px", ErrInvalidImage, width, height, MaxImageSide)
	case uint64(width)*uint64(height) > MaxImagePixels:
		return 0, 0, fmt.Errorf("%w: the image is %d×%d; its area must be at most 16 MP", ErrInvalidImage, width, height)
	}
	return int(width), int(height), nil
}

// chunkName reports a chunk type of four ASCII letters.
func chunkName(kind string) bool {
	for i := range len(kind) {
		if c := kind[i]; (c < 'A' || c > 'Z') && (c < 'a' || c > 'z') {
			return false
		}
	}
	return len(kind) == 4
}

// pngSize reads the size from a checked PNG's IHDR.
func pngSize(data []byte) (int, int, bool) {
	if len(data) < 24 || !bytes.HasPrefix(data, pngSignature) || string(data[12:16]) != "IHDR" {
		return 0, 0, false
	}
	return int(binary.BigEndian.Uint32(data[16:])), int(binary.BigEndian.Uint32(data[20:])), true
}

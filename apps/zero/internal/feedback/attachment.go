package feedback

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Attachments (decision 0176) are the screenshots of visual threads, PNG
// only, kept beside the feedback that holds them:
//
//	<repository directory>/
//	  fb-3k2q8m/at-7hq2mx4kpa.png   attachments of fb-3k2q8m
//	  staging/at-q3v6ne2wjd.png     uploads not yet in a thread
//
// An upload is staged for StagedLifetime; creating a thread moves it into
// its feedback's directory. Every staging and thread creation, under the
// repository lock, sweeps staged files past their lifetime, the temporary
// files of uploads interrupted as long ago (decision 0179), and attachments
// no feedback references.

// Attachment bounds (decision 0176).
const (
	// MaxAttachmentBytes bounds one upload.
	MaxAttachmentBytes = 8 << 20
	// MaxStaged bounds a repository's staged uploads; the oldest is dropped.
	MaxStaged = 16
	// StagedLifetime is how long an upload waits for its thread.
	StagedLifetime = time.Hour
	// MaxAttachmentsPerFeedback bounds one feedback's attachments.
	MaxAttachmentsPerFeedback = 64
	// MaxAttachmentBytesPerFeedback bounds one feedback's attachment bytes.
	MaxAttachmentBytesPerFeedback = 256 << 20
	// MaxAttachmentBytesPerRepository bounds a repository's attachment bytes.
	MaxAttachmentBytesPerRepository = 1 << 30
)

const stagingDirectory = "staging"

// stagingTemporary begins the name of an upload's temporary file, renamed
// to at-<id>.png once written.
const stagingTemporary = ".attachment-"

func (s *Store) stagingFile(repository, attachment string) string {
	return filepath.Join(s.repositoryDirectory(repository), stagingDirectory, attachment+".png")
}

func (s *Store) attachmentDirectory(repository, id string) string {
	return filepath.Join(s.repositoryDirectory(repository), id)
}

// AttachmentFile is where repository's feedback id keeps attachment, whether
// or not it is there.
func (s *Store) AttachmentFile(repository, id, attachment string) string {
	return filepath.Join(s.attachmentDirectory(repository, id), attachment+".png")
}

// HasAttachment reports whether feedback id of repository still holds
// attachment's file.
func (s *Store) HasAttachment(repository, id, attachment string) bool {
	if !idPattern.MatchString(id) || !attachmentPattern.MatchString(attachment) {
		return false
	}
	info, err := os.Lstat(s.AttachmentFile(repository, id, attachment))
	return err == nil && info.Mode().IsRegular()
}

// Stage stores a checked PNG among repository's uploads under a new ID from
// newID, its file's time now: it sweeps, drops the oldest uploads past
// MaxStaged, and writes through a temporary file and rename, under the
// repository lock.
func (s *Store) Stage(repository string, data []byte, now time.Time, newID func() (string, error)) (string, error) {
	staging := filepath.Join(s.repositoryDirectory(repository), stagingDirectory)
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return "", fmt.Errorf("create staging directory: %w", err)
	}
	unlock, err := lockFile(filepath.Join(s.repositoryDirectory(repository), repositoryLock))
	if err != nil {
		return "", err
	}
	defer unlock()
	if err := s.sweep(repository, now); err != nil {
		return "", err
	}
	staged, err := s.staged(repository)
	if err != nil {
		return "", err
	}
	for len(staged) >= MaxStaged {
		_ = os.Remove(staged[0].file)
		staged = staged[1:]
	}
	var id string
	for attempt := 0; ; attempt++ {
		if id, err = newID(); err != nil {
			return "", err
		}
		if _, err := os.Lstat(s.stagingFile(repository, id)); errors.Is(err, fs.ErrNotExist) {
			break
		}
		if attempt == 16 {
			return "", errors.New("no free attachment ID")
		}
	}
	name := s.stagingFile(repository, id)
	if err := writePrivate(name, stagingTemporary+"*", data); err != nil {
		return "", fmt.Errorf("write upload: %w", err)
	}
	if err := os.Chtimes(name, now, now); err != nil {
		return "", fmt.Errorf("write upload: %w", err)
	}
	return id, nil
}

// stagedFile is one staged upload.
type stagedFile struct {
	file     string
	modified time.Time
}

// staged lists repository's staged uploads, oldest first.
func (s *Store) staged(repository string) ([]stagedFile, error) {
	directory := filepath.Join(s.repositoryDirectory(repository), stagingDirectory)
	entries, err := os.ReadDir(directory)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list uploads: %w", err)
	}
	var staged []stagedFile
	for _, entry := range entries {
		id, ok := strings.CutSuffix(entry.Name(), ".png")
		if !ok || !attachmentPattern.MatchString(id) || !entry.Type().IsRegular() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		staged = append(staged, stagedFile{file: filepath.Join(directory, entry.Name()), modified: info.ModTime()})
	}
	slices.SortStableFunc(staged, func(a, b stagedFile) int { return a.modified.Compare(b.modified) })
	return staged, nil
}

// Staged reads repository's upload attachment: its metadata, whether it is
// still within StagedLifetime at now, and whether the repository has it at
// all.
func (s *Store) Staged(repository, attachment string, now time.Time) (Attachment, bool, bool) {
	if !attachmentPattern.MatchString(attachment) {
		return Attachment{}, false, false
	}
	name := s.stagingFile(repository, attachment)
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() > MaxAttachmentBytes {
		return Attachment{}, false, false
	}
	data, err := os.ReadFile(name)
	if err != nil {
		return Attachment{}, false, false
	}
	width, height, ok := pngSize(data)
	if !ok {
		return Attachment{}, false, false
	}
	sum := sha256.Sum256(data)
	metadata := Attachment{ID: attachment, MediaType: MediaTypePNG, Width: width, Height: height, Bytes: int64(len(data)), SHA256: hex.EncodeToString(sum[:])}
	return metadata, live(info.ModTime(), now), true
}

func live(modified, now time.Time) bool { return now.Sub(modified) < StagedLifetime }

// adopt moves a live upload into f's directory for a new visual thread,
// first sweeping and making room within the bounds. The caller holds the
// repository lock and f's lock, and writes f after. A failed write leaves
// the moved file for a later sweep.
func (s *Store) adopt(f *Feedback, attachment string, now time.Time) error {
	if err := s.sweep(f.Repository, now); err != nil {
		return err
	}
	staged := s.stagingFile(f.Repository, attachment)
	info, err := os.Lstat(staged)
	if err != nil || !info.Mode().IsRegular() || !live(info.ModTime(), now) {
		return Problems{{Field: "visual.attachment", Message: staleUpload}}
	}
	if err := s.makeRoom(f, info.Size()); err != nil {
		return err
	}
	if err := os.MkdirAll(s.attachmentDirectory(f.Repository, f.ID), 0o700); err != nil {
		return fmt.Errorf("create attachment directory: %w", err)
	}
	if err := os.Rename(staged, s.AttachmentFile(f.Repository, f.ID, attachment)); err != nil {
		return fmt.Errorf("store attachment: %w", err)
	}
	return nil
}

// heldAttachment is one stored attachment's file and its thread's state.
type heldAttachment struct {
	feedback string
	thread   int
	closed   bool
	updated  time.Time
	file     string
	size     int64
}

// makeRoom keeps a new attachment of size bytes for f within the bounds:
// it drops screenshots of resolved and won't-fix threads, least recently
// updated first, then fails with ErrFull. An open thread's screenshot is
// never dropped. The caller holds the repository lock.
func (s *Store) makeRoom(f *Feedback, size int64) error {
	held, err := s.held(f)
	if err != nil {
		return err
	}
	var count int
	var feedbackBytes, repositoryBytes int64
	for _, attachment := range held {
		repositoryBytes += attachment.size
		if attachment.feedback == f.ID {
			count++
			feedbackBytes += attachment.size
		}
	}
	over := func() (feedbackOver, repositoryOver bool) {
		return count+1 > MaxAttachmentsPerFeedback || feedbackBytes+size > MaxAttachmentBytesPerFeedback, repositoryBytes+size > MaxAttachmentBytesPerRepository
	}
	slices.SortStableFunc(held, func(a, b heldAttachment) int {
		if c := a.updated.Compare(b.updated); c != 0 {
			return c
		}
		if c := strings.Compare(a.feedback, b.feedback); c != 0 {
			return c
		}
		return a.thread - b.thread
	})
	for _, attachment := range held {
		feedbackOver, repositoryOver := over()
		if !feedbackOver && !repositoryOver {
			break
		}
		if !attachment.closed || !repositoryOver && attachment.feedback != f.ID {
			continue
		}
		if err := os.Remove(attachment.file); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("drop screenshot: %w", err)
		}
		repositoryBytes -= attachment.size
		if attachment.feedback == f.ID {
			count--
			feedbackBytes -= attachment.size
		}
	}
	const fix = "resolve or delete threads with screenshots, then try again"
	switch feedbackOver, repositoryOver := over(); {
	case count+1 > MaxAttachmentsPerFeedback:
		return fmt.Errorf("%w: feedback %s holds %d screenshots, the most it may; %s", ErrFull, f.ID, MaxAttachmentsPerFeedback, fix)
	case feedbackOver:
		return fmt.Errorf("%w: feedback %s's screenshots would pass 256 MiB; %s", ErrFull, f.ID, fix)
	case repositoryOver:
		return fmt.Errorf("%w: this repository's screenshots would pass 1 GiB; resolve or delete threads with screenshots, or delete old feedback, then try again", ErrFull)
	}
	return nil
}

// held lists the repository's stored attachments that are still there: f's
// as given, every other feedback's as stored. A feedback that cannot be read
// holds none the bounds know of.
func (s *Store) held(f *Feedback) ([]heldAttachment, error) {
	summaries, err := s.List(f.Repository)
	if err != nil {
		return nil, err
	}
	feedbacks := []Feedback{*f}
	for _, summary := range summaries {
		if summary.ID == f.ID {
			continue
		}
		if other, err := s.read(f.Repository, summary.ID); err == nil {
			feedbacks = append(feedbacks, other)
		}
	}
	var held []heldAttachment
	for _, feedback := range feedbacks {
		for _, thread := range feedback.Threads {
			if thread.Visual == nil || !attachmentPattern.MatchString(thread.Visual.Attachment.ID) {
				continue
			}
			file := s.AttachmentFile(f.Repository, feedback.ID, thread.Visual.Attachment.ID)
			info, err := os.Lstat(file)
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			held = append(held, heldAttachment{feedback: feedback.ID, thread: thread.Number, closed: thread.Status != StatusOpen, updated: thread.UpdatedAt, file: file, size: info.Size()})
		}
	}
	return held, nil
}

// sweep removes repository's staged uploads past StagedLifetime at now, the
// temporary files of uploads interrupted as long ago (decision 0179), and
// attachment files no feedback references, with the directories of
// feedback that is gone. A feedback that cannot be read keeps its files.
// The caller holds the repository lock.
func (s *Store) sweep(repository string, now time.Time) error {
	staged, err := s.staged(repository)
	if err != nil {
		return err
	}
	for _, upload := range staged {
		if !live(upload.modified, now) {
			_ = os.Remove(upload.file)
		}
	}
	s.sweepInterrupted(repository, now)
	directory := s.repositoryDirectory(repository)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return fmt.Errorf("list feedback: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() || !idPattern.MatchString(entry.Name()) {
			continue
		}
		id := entry.Name()
		referenced := map[string]bool{}
		f, err := s.read(repository, id)
		switch {
		case err == nil:
			for _, thread := range f.Threads {
				if thread.Visual != nil {
					referenced[thread.Visual.Attachment.ID] = true
				}
			}
		case !errors.Is(err, ErrNotFound):
			continue
		}
		files, err := os.ReadDir(filepath.Join(directory, id))
		if err != nil {
			continue
		}
		for _, file := range files {
			attachment, ok := strings.CutSuffix(file.Name(), ".png")
			if ok && attachmentPattern.MatchString(attachment) && !referenced[attachment] {
				_ = os.Remove(filepath.Join(directory, id, file.Name()))
			}
		}
		if len(referenced) == 0 {
			// Only an empty directory goes.
			_ = os.Remove(filepath.Join(directory, id))
		}
	}
	return nil
}

// sweepInterrupted removes the temporary files that uploads interrupted
// before their rename left in repository's staging directory, once they
// are StagedLifetime old at now; a younger one may be an upload still
// being written. The caller holds the repository lock.
func (s *Store) sweepInterrupted(repository string, now time.Time) {
	directory := filepath.Join(s.repositoryDirectory(repository), stagingDirectory)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), stagingTemporary) || !entry.Type().IsRegular() {
			continue
		}
		if info, err := entry.Info(); err == nil && !live(info.ModTime(), now) {
			_ = os.Remove(filepath.Join(directory, entry.Name()))
		}
	}
}

// writePrivate replaces name atomically with a 0600 file holding data,
// through a temporary file named by pattern beside it.
func writePrivate(name, pattern string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(name), pattern)
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer func() { _ = os.Remove(temporary) }()
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(temporary, name)
}

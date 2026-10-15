package queries

import "strings"

// normalizeSynopsis cleans the text of a synopsis element: CRLF becomes LF, a
// blank line (one that holds only whitespace) separates paragraphs, whitespace
// inside a paragraph collapses to single spaces, and empty paragraphs are
// dropped. Paragraphs are joined with exactly one blank line.
func normalizeSynopsis(raw string) string {
	raw = strings.ReplaceAll(raw, "\r\n", "\n")

	var paragraphs []string
	var lines []string
	flush := func() {
		if len(lines) > 0 {
			paragraphs = append(paragraphs, strings.Join(lines, " "))
			lines = nil
		}
	}
	for _, line := range strings.Split(raw, "\n") {
		if words := strings.Fields(line); len(words) > 0 {
			lines = append(lines, strings.Join(words, " "))
		} else {
			flush()
		}
	}
	flush()

	return strings.Join(paragraphs, "\n\n")
}

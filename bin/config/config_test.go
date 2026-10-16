package config

import (
	"testing"
	"time"
)

// config.init() panics unless PORT and BASE_URL are set, so run these tests with:
//
//	PORT=0 BASE_URL=https://komiku.org/ go test ./bin/config
func TestParseCacheMaxMB(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"", defaultProxyCacheMaxMB},
		{"   ", defaultProxyCacheMaxMB},
		{"256", 256},
		{" 2048 ", 2048},
		{"1", 1},
		{"0", defaultProxyCacheMaxMB},
		{"-5", defaultProxyCacheMaxMB},
		{"abc", defaultProxyCacheMaxMB},
		{"1.5", defaultProxyCacheMaxMB},
		{"10GB", defaultProxyCacheMaxMB},
		{"99999999999999999999", defaultProxyCacheMaxMB},
		{"9223372036854775807", defaultProxyCacheMaxMB},
	}
	for _, tt := range tests {
		if got := parseCacheMaxMB(tt.in); got != tt.want {
			t.Errorf("parseCacheMaxMB(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestParseBoundedInt(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"", 3},
		{"  ", 3},
		{"0", 0},
		{"5", 5},
		{" 7 ", 7},
		{"16", 16},
		{"17", 16},
		{"99999999999999999999", 3},
		{"-1", 3},
		{"abc", 3},
		{"2.5", 3},
	}
	for _, tt := range tests {
		if got := parseBoundedInt("X", tt.in, 3, 16); got != tt.want {
			t.Errorf("parseBoundedInt(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestParsePrewarmInterval(t *testing.T) {
	tests := []struct {
		in   string
		want time.Duration
	}{
		{"", defaultPrewarmInterval},
		{"0", 0},
		{"0s", 0},
		{"20m", 20 * time.Minute},
		{" 1h ", time.Hour},
		{"90s", 90 * time.Second},
		{"1m", time.Minute},
		{"5s", minPrewarmInterval},
		{"-5m", defaultPrewarmInterval},
		{"20", defaultPrewarmInterval},
		{"soon", defaultPrewarmInterval},
	}
	for _, tt := range tests {
		if got := parsePrewarmInterval(tt.in); got != tt.want {
			t.Errorf("parsePrewarmInterval(%q) = %s, want %s", tt.in, got, tt.want)
		}
	}
}

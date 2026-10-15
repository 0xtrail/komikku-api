package config

import "testing"

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

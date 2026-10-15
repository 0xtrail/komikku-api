package domain

type ChapterDetail struct {
	Title	string 		`json:"title"`
	Image	[]string	`json:"image"`
	MangaEndpoint	string	`json:"manga_endpoint"`
	MangaTitle	string	`json:"manga_title"`
	PrevEndpoint	string	`json:"prev_endpoint"`
	NextEndpoint	string	`json:"next_endpoint"`
}

type Chapter struct {
Name		string 		`json:"name"`
Endpoint	string		`json:"endpoint"`
}
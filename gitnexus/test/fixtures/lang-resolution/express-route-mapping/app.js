const app = require("express")();

app.get("/api/items", (_req, res) => {
	res.json({ items: [] });
});

app.post("/api/items", (_req, res) => {
	res.json({ created: true });
});

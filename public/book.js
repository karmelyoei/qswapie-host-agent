// "Today's book": every client of the day with turn number, planned time, service and state (shared by both pages).
const BOOK_CHIP = { "in chair": "chair", called: "wait", waiting: "wait", booked: "booked", done: "done", "no-show": "gone", cancelled: "gone" };
function bookHtml(book, selId) {
  return book.map((r) => {
    const chip = r.isNew && r.state === "booked" ? "new" : BOOK_CHIP[r.state] || "booked";
    const label = r.isNew && r.state === "booked" ? "new" : r.state;
    return `<div class="bk-row ${r.state === "cancelled" ? "bk-x" : ""} ${r.id === selId ? "bk-sel" : ""}" data-id="${r.id}">
      <span class="bk-n">#${r.n}</span><span class="bk-t">${r.time}</span>
      <span class="bk-who"><b>${esc(r.name)}</b><small>${esc(r.svc)}${r.note ? " · " + esc(r.note) : ""}</small></span>
      <span class="bk-chip bk-${chip}">${esc(label)}</span></div>`;
  }).join("");
}
document.addEventListener("DOMContentLoaded", () => {
  const st = document.createElement("style");
  st.textContent = `
  .bk-row { display:grid; grid-template-columns: 2.4em 3.6em 1fr auto; gap:8px; align-items:center; padding:7px 8px; border-radius:10px; font-size:16px; line-height:1.25; cursor:pointer; }
  .bk-row:nth-child(odd) { background:#ffffff08; }
  .bk-row.bk-sel { outline:2px solid #ff7a59; }
  .bk-n { color:#9aa3b2; font:600 15px ui-monospace, monospace; }
  .bk-t { font:700 16px ui-monospace, monospace; }
  .bk-who b { display:block; font-size:16px; }
  .bk-who small { color:#b4c2d8; font-size:13px; }
  .bk-chip { font-size:12px; font-weight:700; padding:3px 9px; border-radius:99px; text-transform:uppercase; letter-spacing:.03em; white-space:nowrap; }
  .bk-chair { background:#1f3b2c; color:#7fe0a8; }
  .bk-wait { background:#4a3a0a; color:#ffd071; }
  .bk-booked { background:#2b2f3a; color:#c9d2e3; }
  .bk-done { background:#1d2230; color:#7c8598; }
  .bk-gone { background:#4a1d1d; color:#ff9b9b; }
  .bk-new { background:#0c3a52; color:#7cddff; }
  .bk-x .bk-who b, .bk-x .bk-t { text-decoration: line-through; opacity:.7; }`;
  document.head.appendChild(st);
});

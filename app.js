(function(){
"use strict";

/* ================= basics ================= */
const MEALS = ["Breakfast","Lunch","Dinner","Snacks"];
const KEY = "fuel-ledger-v1";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2,"0");
const keyOf = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const fromKey = k => { const [y,m,d] = k.split("-").map(Number); return new Date(y, m-1, d); };
const num = v => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isFinite(n) && n >= 0 ? n : 0; };
const r0 = n => Math.round(n);
const r1 = n => Math.round(n*10)/10;
const fmt = n => r0(n).toLocaleString();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

/* ================= storage ================= */
function blank(){ return { targets: null, foods: {}, days: {}, settings: { usdaKey: "", lastBackup: 0, hideInstall: false } }; }
function load(){
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && typeof d === "object") {
      const b = blank();
      return { ...b, ...d, settings: { ...b.settings, ...(d.settings || {}) }, foods: d.foods || {}, days: d.days || {} };
    }
  } catch {}
  return blank();
}
let DB = load();
let persistAsked = false;
function save(){
  try { localStorage.setItem(KEY, JSON.stringify(DB)); }
  catch { toast("Couldn't save. Your phone's browser storage may be full."); return false; }
  if (!persistAsked && navigator.storage && navigator.storage.persist) { persistAsked = true; navigator.storage.persist().catch(() => {}); }
  return true;
}

let date = keyOf(new Date());
const dayEntries = () => DB.days[date] || [];
function setDayEntries(list){ if (list.length) DB.days[date] = list; else delete DB.days[date]; save(); }

/* ================= math ================= */
function totals(list){
  return list.reduce((t,e) => ({ kcal: t.kcal + (e.kcal||0), p: t.p + (e.p||0), c: t.c + (e.c||0), f: t.f + (e.f||0) }), {kcal:0,p:0,c:0,f:0});
}
function compute(food, amount, unit){
  if (unit === "g" && food.per100) {
    const k = amount / 100;
    return { kcal: r0(food.per100.kcal*k), p: r1(food.per100.p*k), c: r1(food.per100.c*k), f: r1(food.per100.f*k) };
  }
  return { kcal: r0(food.kcal*amount), p: r1(food.p*amount), c: r1(food.c*amount), f: r1(food.f*amount) };
}
function defaultMeal(){
  const h = new Date().getHours();
  return h < 11 ? "Breakfast" : h < 16 ? "Lunch" : h < 21 ? "Dinner" : "Snacks";
}

/* ================= barcodes ================= */
function upceToUpca(e){
  const n = e[0], d = e.slice(1,7), c = e[7], x = d[5];
  let m;
  if ("012".includes(x)) m = d[0]+d[1]+x+"0000"+d[2]+d[3]+d[4];
  else if (x === "3") m = d[0]+d[1]+d[2]+"00000"+d[3]+d[4];
  else if (x === "4") m = d[0]+d[1]+d[2]+d[3]+"00000"+d[4];
  else m = d[0]+d[1]+d[2]+d[3]+d[4]+"0000"+x;
  return n + m + c;
}
function normCode(raw, isUpcE){
  let d = String(raw || "").replace(/\D/g, "");
  if (isUpcE && d.length === 8) d = upceToUpca(d);
  if (d.length === 13 && d[0] === "0") d = d.slice(1);   // EAN-13 with leading 0 is the same product as UPC-A
  return d;
}
function checkDigitOk(d){
  if (![8,12,13,14].includes(d.length)) return false;
  let sum = 0;
  for (let i = d.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(d[i]) * w;
  return (10 - sum % 10) % 10 === Number(d[d.length-1]);
}

/* ================= food databases ================= */
const OFF_FIELDS = "code,product_name,generic_name,brands,serving_size,serving_quantity,nutriments";
function offNumber(n, key, suf){ const v = n[key + "_" + suf]; return v === undefined || v === null || v === "" ? null : Number(v); }
function offKcal(n, suf){
  let v = offNumber(n, "energy-kcal", suf);
  if (v === null) { const kj = offNumber(n, "energy-kj", suf) ?? offNumber(n, "energy", suf); if (kj !== null) v = kj / 4.184; }
  return v;
}
function fromOFF(p){
  if (!p) return null;
  const n = p.nutriments || {};
  const code = normCode(p.code);
  const k100 = offKcal(n, "100g");
  const per100 = k100 !== null ? { kcal: r1(k100), p: r1(offNumber(n,"proteins","100g")||0), c: r1(offNumber(n,"carbohydrates","100g")||0), f: r1(offNumber(n,"fat","100g")||0) } : null;
  const servingG = Number(p.serving_quantity) || null;
  const kS = offKcal(n, "serving");
  let serv = null, serving = p.serving_size || "";
  if (kS !== null) serv = { kcal: kS, p: offNumber(n,"proteins","serving")||0, c: offNumber(n,"carbohydrates","serving")||0, f: offNumber(n,"fat","serving")||0 };
  else if (per100 && servingG) { const k = servingG/100; serv = { kcal: per100.kcal*k, p: per100.p*k, c: per100.c*k, f: per100.f*k }; if (!serving) serving = servingG + " g"; }
  else if (per100) { serv = per100; serving = "100 g"; }
  if (!serv) return null;
  return {
    id: code ? "upc" + code : "off" + uid(), code,
    name: (p.product_name || p.generic_name || "Unnamed product").trim(),
    brand: String(p.brands || "").split(",")[0].trim(),
    serving: serving || "1 serving", servingG: serv === per100 ? 100 : servingG,
    kcal: r0(serv.kcal), p: r1(serv.p), c: r1(serv.c), f: r1(serv.f),
    per100, source: "off"
  };
}
async function fetchJSON(url, ms){
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 429) throw Object.assign(new Error("rate"), { kind: "rate" });
    if (!r.ok) throw Object.assign(new Error("http " + r.status), { kind: "http", status: r.status });
    return await r.json();
  } catch (e) {
    if (e.kind) throw e;
    throw Object.assign(new Error("network"), { kind: navigator.onLine === false ? "offline" : "network" });
  } finally { clearTimeout(t); }
}
async function lookupBarcode(code){
  const tries = [code];
  if (code.length === 12) tries.push("0" + code);
  for (const c of tries) {
    const j = await fetchJSON("https://world.openfoodfacts.org/api/v2/product/" + c + ".json?fields=" + OFF_FIELDS);
    if (j && j.status === 1 && j.product) {
      const food = fromOFF({ ...j.product, code });
      if (food) return food;
      return { incomplete: true, name: j.product.product_name || "", brand: String(j.product.brands||"").split(",")[0].trim() };
    }
  }
  return null;
}
async function searchOFF(q){
  const url = "https://world.openfoodfacts.org/cgi/search.pl?search_terms=" + encodeURIComponent(q)
    + "&search_simple=1&action=process&json=1&page_size=15&fields=" + OFF_FIELDS
    + "&tagtype_0=countries&tag_contains_0=contains&tag_0=united-states";
  const j = await fetchJSON(url, 15000);
  return (j.products || []).map(fromOFF).filter(Boolean);
}
/* --- turning everyday words into USDA's wording --- */
const KEEP_S = new Set(["oats","grits","hummus","asparagus","couscous","swiss","bass","molasses","lentils","greens","citrus","octopus","series"]);
function singular(w){
  if (w.length <= 3 || KEEP_S.has(w)) return w;
  if (w.endsWith("ies")) return w.slice(0,-3) + "y";
  if (w.endsWith("oes")) return w.slice(0,-2);
  if (w.endsWith("ches") || w.endsWith("shes")) return w.slice(0,-2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0,-1);
  return w;
}
const COOK_WORDS = ["cooked","baked","roasted","grilled","fried","broiled","boiled","steamed","stewed","braised","poached","sauteed","rotisserie","smoked","scrambled"];
const FILLER = new Set(["skinless","boneless","skin","bone","bones","without","with","no","and","the","of","a","an","plain","fresh","raw","uncooked","meat","only","piece","pieces"]);
function parseQuery(q){
  const words = q.toLowerCase().replace(/[^a-z0-9%\s-]/g, " ").split(/\s+/).filter(Boolean).map(singular);
  const has = w => words.includes(w);
  const cookMethods = words.filter(w => COOK_WORDS.includes(w) && w !== "cooked");
  const core = words.filter(w => !FILLER.has(w) && !COOK_WORDS.includes(w));
  return {
    core,
    apiQuery: (core.length ? core : words).join(" "),
    cooked: has("cooked") || cookMethods.length > 0,
    raw: has("raw") || has("uncooked"),
    cookMethods,
    skinless: has("skinless") || (has("no") && has("skin")) || (has("without") && has("skin"))
  };
}
function scoreUSDA(desc, pq, dataType){
  const d = desc.toLowerCase();
  const dWords = new Set(d.replace(/[^a-z0-9%\s]/g, " ").split(/\s+/).filter(Boolean).map(singular));
  let score = 0, matched = 0;
  pq.core.forEach(w => { if (dWords.has(w)) matched++; });
  score += matched * 4 - (pq.core.length - matched) * 7;
  if (pq.core.length && matched === 0) return -999;
  const isRaw = /\braw\b/.test(d);
  const isCooked = COOK_WORDS.some(w => d.includes(w));
  if (pq.cooked) {
    score += isCooked ? 3 : 0;
    if (isRaw) score -= 6;
    pq.cookMethods.forEach(m => { if (d.includes(m)) score += 3; });
    if (pq.cookMethods.includes("grilled") && /broiled|roasted/.test(d)) score += 2;
    if (!pq.cookMethods.includes("fried") && /\bfried\b|batter|breaded|coated/.test(d)) score -= 2;
  }
  if (pq.raw) { score += isRaw ? 3 : 0; if (isCooked) score -= 4; }
  if (pq.skinless) {
    if (/meat only|skin not eaten|skinless|without skin|skin removed/.test(d)) score += 4;
    if (/meat and skin|skin eaten|with skin|skin only/.test(d)) score -= 6;
  }
  if (/giblet|skin only|separable fat|composite|back,|neck|mechanically/.test(d)) score -= 3;
  if (dataType === "Foundation" || dataType === "SR Legacy") score += 0.5;
  score -= d.split(",").length * 0.25;   // shorter, plainer names first
  return score;
}
function tidyUSDAName(s){
  let n = String(s || "Food").replace(/\b([A-Z])([A-Z]+)\b/g, (m,a,b) => a + b.toLowerCase());
  n = n.replace(/,\s*broilers? or fryers/i, "").replace(/,\s*NFS\b/, "").replace(/,\s*NS as to [^,]+/i, "");
  return n;
}
async function searchUSDA(q){
  const key = (DB.settings.usdaKey || "").trim() || "DEMO_KEY";
  const pq = parseQuery(q);
  const url = "https://api.nal.usda.gov/fdc/v1/foods/search?api_key=" + encodeURIComponent(key)
    + "&query=" + encodeURIComponent(pq.apiQuery)
    + "&dataType=Foundation&dataType=SR%20Legacy&dataType=Survey%20%28FNDDS%29&pageSize=60";
  const j = await fetchJSON(url, 15000);
  const ranked = (j.foods || [])
    .map(fd => ({ fd, s: scoreUSDA(fd.description || "", pq, fd.dataType) }))
    .filter(x => x.s > -999)
    .sort((a,b) => b.s - a.s);
  const seen = new Set();
  return ranked.filter(({fd}) => { const k = tidyUSDAName(fd.description).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 15).map(({fd}) => fd).map(fd => {
    const by = id => { const x = (fd.foodNutrients || []).find(n => n.nutrientId === id && (id !== 1008 && id !== 2047 && id !== 2048 || String(n.unitName).toUpperCase() === "KCAL")); return x ? Number(x.value) : null; };
    const p = by(1003) || 0, c = by(1005) || 0, f = by(1004) || 0;
    let kcal = by(1008) ?? by(2047) ?? by(2048);
    if (kcal === null) kcal = p*4 + c*4 + f*9;
    const per100 = { kcal: r1(kcal), p: r1(p), c: r1(c), f: r1(f) };
    const name = tidyUSDAName(fd.description);
    return { id: "usda" + fd.fdcId, code: "", name, brand: "", serving: "100 g", servingG: 100, kcal: r0(per100.kcal), p: per100.p, c: per100.c, f: per100.f, per100, source: "usda" };
  });
}
function netError(e, what){
  if (!e) return "Something went wrong.";
  if (e.kind === "offline") return "You're offline, so " + what + " isn't available right now.";
  if (e.kind === "rate") return what[0].toUpperCase() + what.slice(1) + " is limiting requests right now. Try again in a few minutes.";
  return "Couldn't reach " + what + ". Check your connection and try again.";
}

/* ================= render ================= */
function render(){
  const today = keyOf(new Date());
  const d = fromKey(date);
  const isToday = date === today;
  const yest = keyOf(new Date(Date.now() - 864e5));
  const long = d.toLocaleDateString(undefined, {weekday:"short", month:"short", day:"numeric"});
  const list = dayEntries();
  $("dateLabel").textContent = isToday ? "Today · " + long : date === yest ? "Yesterday · " + long : long;
  $("nextDay").disabled = isToday;
  $("factsTitle").textContent = isToday ? "Today" : d.toLocaleDateString(undefined, {weekday:"long"});
  $("factsSub").textContent = list.length + (list.length === 1 ? " item" : " items") + " logged · " + long;

  const t = totals(list), g = DB.targets;
  $("calEaten").textContent = fmt(t.kcal);
  if (g && g.kcal) {
    const left = g.kcal - t.kcal;
    $("calLeft").textContent = "of " + fmt(g.kcal) + " · " + (left >= 0 ? fmt(left) + " left" : fmt(-left) + " over");
  } else $("calLeft").textContent = "Set targets to track what's left";
  $("setCta").hidden = !!(g && g.kcal);

  $("macroRows").innerHTML = [["Protein","p","protein"],["Carbs","c","carbs"],["Fat","f","fat"]].map(([label,k,col]) => {
    const tgt = g && g[k] ? g[k] : 0;
    const pct = tgt ? Math.round(t[k] / tgt * 100) : null;
    return '<div class="mrow"><div><b>'+label+'</b><span class="amt">'+r1(t[k])+' g'+(tgt?' / '+tgt+' g':'')+'</span></div>'
      + '<div class="pct">'+(pct===null?'—':pct+'%')+'</div>'
      + '<div class="bar"><i style="width:'+Math.min(100, pct||0)+'%;background:var(--'+col+')"></i></div></div>';
  }).join("");

  const host = $("meals");
  if (!list.length) {
    host.innerHTML = '<div class="empty"><b>Nothing logged '+(isToday?'today':'on this day')+' yet</b>Tap Scan barcode and point your camera at a package to log your first item.</div>';
    return;
  }
  host.innerHTML = MEALS.map(m => {
    const items = list.filter(e => e.meal === m);
    if (!items.length) return "";
    const mt = totals(items);
    return '<section class="meal"><h2>'+m+'<span>'+fmt(mt.kcal)+' kcal</span></h2><ul class="entries">'
      + items.map(e => '<li class="entry"><div class="nm">'+esc(e.name)+'<small>'+esc(e.amountLabel || "")+(e.brand?' · '+esc(e.brand):'')+'</small></div>'
        + '<div class="kc">'+fmt(e.kcal)+'<small><span class="p">P'+r0(e.p)+'</span> <span class="c">C'+r0(e.c)+'</span> <span class="f">F'+r0(e.f)+'</span></small></div>'
        + '<button class="x" type="button" data-act="del-entry" data-id="'+esc(e.id)+'" aria-label="Remove '+esc(e.name)+'">×</button></li>').join("")
      + '</ul></section>';
  }).join("");
}

/* ================= toast ================= */
let toastEl = null, toastT = 0;
function toast(msg){
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.setAttribute("role", "status");
    toastEl.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(88px + env(safe-area-inset-bottom,0px));z-index:40;background:var(--ink);color:var(--paper);padding:10px 16px;border-radius:10px;font-weight:600;font-size:14px;max-width:calc(100% - 32px);text-align:center";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

/* ================= sheet ================= */
let ctx = {};
function openSheet(html, c){
  ctx = c || {};
  $("sheet").innerHTML = html;
  $("sheet").hidden = false; $("scrim").hidden = false;
  $("sheet").scrollTop = 0;
}
function closeSheet(){
  $("sheet").hidden = true; $("scrim").hidden = true; $("sheet").innerHTML = ""; ctx = {};
}
function busy(title, lead){
  openSheet('<h3>'+esc(title)+'</h3><p class="lead">'+esc(lead)+'</p><div class="spin" role="status" aria-label="Working"></div><button class="btn" type="button" data-act="close" style="width:100%">Cancel</button>', { busy: true });
  return ctx;
}
$("scrim").addEventListener("click", closeSheet);

function mealSeg(sel){
  return '<div class="seg" role="group" aria-label="Meal">' + MEALS.map(m => '<button type="button" data-act="meal" data-meal="'+m+'" aria-pressed="'+(m===sel)+'">'+m+'</button>').join("") + '</div>';
}
const srcLabel = s => s === "usda" ? "USDA" : s === "off" ? "Open Food Facts" : "";

/* --- log a food --- */
function showLog(food){
  const unit = food.source === "usda" ? "g" : "srv";
  const amount = unit === "g" ? 100 : 1;
  openSheet(
    '<h3>'+esc(food.name)+'</h3><p class="lead">'+[food.brand && esc(food.brand), esc(food.serving || "1 serving"), food.code && '<span class="code">'+esc(food.code)+'</span>', srcLabel(food.source) && "from " + srcLabel(food.source)].filter(Boolean).join(" · ")+'</p>'
    + '<div class="stack">'
    + (food.per100 ? '<div class="field"><label>Amount in</label><div class="seg" role="group" aria-label="Unit"><button type="button" data-act="unit" data-unit="srv" aria-pressed="'+(unit==="srv")+'">Servings</button><button type="button" data-act="unit" data-unit="g" aria-pressed="'+(unit==="g")+'">Grams</button></div></div>' : '')
    + '<div class="field"><label for="amt" id="amtLabel">'+(unit==="g"?"Grams":"Servings")+'</label><div class="stepper"><button type="button" data-act="step" data-d="-1" aria-label="Less">−</button><input id="amt" inputmode="decimal" value="'+amount+'"><button type="button" data-act="step" data-d="1" aria-label="More">+</button></div></div>'
    + '<div class="field"><label>Meal</label>'+mealSeg(defaultMeal())+'</div>'
    + '<div class="preview" id="logPreview"></div>'
    + '<button class="btn primary" type="button" data-act="do-log">Log it</button>'
    + '<div style="display:flex;justify-content:space-between;gap:12px"><button class="linkish" type="button" data-act="edit-food">Edit nutrition</button><button class="linkish" type="button" data-act="close">Cancel</button></div>'
    + '</div>', { food, unit, meal: defaultMeal() });
  updatePreview();
}
function updatePreview(){
  const el = $("logPreview"); if (!el || !ctx.food) return;
  const s = compute(ctx.food, num($("amt").value), ctx.unit);
  el.innerHTML = '<div>kcal<b>'+fmt(s.kcal)+'</b></div><div class="p">Protein<b>'+r1(s.p)+'g</b></div><div class="c">Carbs<b>'+r1(s.c)+'g</b></div><div class="f">Fat<b>'+r1(s.f)+'g</b></div>';
}

/* --- food form --- */
function showFoodForm(food, opts){
  food = food || {}; opts = opts || {};
  const v = k => food[k] !== undefined && food[k] !== null ? esc(food[k]) : "";
  const saved = food.id && DB.foods[food.id];
  openSheet(
    '<h3>'+esc(opts.title || (saved ? "Edit food" : "New food"))+'</h3>'
    + '<p class="lead">'+(opts.lead || "Enter the numbers per serving from the Nutrition Facts label.")+'</p>'
    + '<form class="stack" id="foodForm" novalidate>'
    + '<div class="field"><label for="fName">Name</label><input id="fName" value="'+v("name")+'" placeholder="e.g. Chocolate protein bar"></div>'
    + '<div class="row2"><div class="field"><label for="fBrand">Brand</label><input id="fBrand" value="'+v("brand")+'" placeholder="Optional"></div>'
    + '<div class="field"><label for="fServing">Serving size</label><input id="fServing" value="'+v("serving")+'" placeholder="1 bar (60g)"></div></div>'
    + '<div class="row2"><div class="field"><label for="fKcal">Calories</label><input id="fKcal" inputmode="decimal" value="'+v("kcal")+'"></div>'
    + '<div class="field"><label for="fP">Protein (g)</label><input id="fP" inputmode="decimal" value="'+v("p")+'"></div></div>'
    + '<div class="row2"><div class="field"><label for="fC">Total carbs (g)</label><input id="fC" inputmode="decimal" value="'+v("c")+'"></div>'
    + '<div class="field"><label for="fF">Total fat (g)</label><input id="fF" inputmode="decimal" value="'+v("f")+'"></div></div>'
    + '<div class="row2"><div class="field"><label for="fG">Grams per serving</label><input id="fG" inputmode="decimal" value="'+v("servingG")+'" placeholder="Optional"></div>'
    + '<div class="field"><label for="fCode">Barcode</label><input id="fCode" inputmode="numeric" value="'+v("code")+'" placeholder="Optional"></div></div>'
    + '<p class="hint">Grams per serving lets you log by weight.</p>'
    + '<p class="err" id="formErr" hidden></p>'
    + '<button class="btn primary" type="submit">'+(opts.logAfter ? "Save and log" : "Save food")+'</button>'
    + (opts.offLink && food.code ? '<a class="linkish" href="https://world.openfoodfacts.org/product/'+esc(food.code)+'" target="_blank" rel="noopener">Add this product to Open Food Facts so others can scan it</a>' : '')
    + (saved ? '<button class="linkish" type="button" data-act="del-food" style="color:var(--warn)">Delete from my foods</button>' : '')
    + '<button class="linkish" type="button" data-act="close">Cancel</button>'
    + '</form>', { editing: food, logAfter: !!opts.logAfter });
  $("foodForm").addEventListener("submit", ev => {
    ev.preventDefault();
    const err = $("formErr");
    const name = $("fName").value.trim();
    if (!name) { err.textContent = "Give the food a name so you can find it later."; err.hidden = false; return; }
    if ($("fKcal").value.trim() === "") { err.textContent = "Add the calories per serving."; err.hidden = false; return; }
    const code = normCode($("fCode").value);
    const id = code ? "upc" + code : (food.id && !String(food.id).startsWith("upc") ? food.id : "f" + uid());
    if (food.id && food.id !== id) delete DB.foods[food.id];
    const servingG = num($("fG").value) || null;
    const kcal = num($("fKcal").value), p = num($("fP").value), c = num($("fC").value), f = num($("fF").value);
    const per100 = servingG ? { kcal: r1(kcal/servingG*100), p: r1(p/servingG*100), c: r1(c/servingG*100), f: r1(f/servingG*100) } : null;
    const rec = { id, code, name, brand: $("fBrand").value.trim(), serving: $("fServing").value.trim() || (servingG ? servingG + " g" : "1 serving"), servingG, kcal, p, c, f, per100, source: "manual", updated: Date.now(), lastUsed: food.lastUsed || 0 };
    DB.foods[id] = rec; save();
    if (ctx.logAfter) showLog(rec); else { toast("Saved " + name); showSearch(""); }
  });
}

/* --- search --- */
let searchSeq = 0;
function showSearch(q){
  openSheet(
    '<h3>Search foods</h3><p class="lead">Your saved foods show first. Search the databases for anything new.</p>'
    + '<form class="stack" id="sForm" novalidate>'
    + '<div class="field"><label for="q">Food</label><input id="q" type="search" enterkeyhint="search" value="'+esc(q||"")+'" placeholder="e.g. greek yogurt, chicken breast" autocomplete="off"></div>'
    + '<p class="hint">Describe it how you\'d say it, like "cooked skinless chicken thigh" or "white rice cooked."</p>'
    + '<button class="btn primary" type="submit">Search databases</button>'
    + '</form>'
    + '<h4>My foods</h4><ul class="results" id="mine"></ul>'
    + '<div id="dbResults"></div>'
    + '<div class="stack" style="margin-top:14px"><button class="btn" type="button" data-act="new-food">Enter a food manually</button></div>');
  const input = $("q");
  input.addEventListener("input", () => listMine(input.value));
  $("sForm").addEventListener("submit", ev => { ev.preventDefault(); input.blur(); runDbSearch(input.value.trim()); });
  listMine(q || "");
}
function foodRow(f, opts){
  return '<li><button class="pick" type="button" data-act="'+(opts.db?'pick-db':'pick')+'" data-id="'+esc(f.id)+'"><b>'+esc(f.name)+(opts.db?'':'')+'</b><small>'+(f.brand?esc(f.brand)+' · ':'')+esc(f.serving||"1 serving")+' · '+fmt(f.kcal)+' kcal · <span class="p">P'+r0(f.p)+'</span> <span class="c">C'+r0(f.c)+'</span> <span class="f">F'+r0(f.f)+'</span></small></button>'
    + (opts.db ? '' : '<button class="ed" type="button" data-act="edit" data-id="'+esc(f.id)+'">Edit</button>') + '</li>';
}
function listMine(q){
  const el = $("mine"); if (!el) return;
  const t = q.trim().toLowerCase();
  let list = Object.values(DB.foods);
  if (t) list = list.filter(f => (f.name+" "+(f.brand||"")+" "+(f.code||"")).toLowerCase().includes(t));
  list.sort((a,b) => (b.lastUsed||b.updated||0) - (a.lastUsed||a.updated||0));
  list = list.slice(0, 30);
  el.innerHTML = list.length ? list.map(f => foodRow(f, {})).join("")
    : '<li style="padding:12px 0;color:var(--muted)">'+(Object.keys(DB.foods).length ? "No saved food matches. Try Search databases." : "Foods you log are saved here, so the next time takes one tap.")+'</li>';
}
let dbCache = {};
async function runDbSearch(q){
  const host = $("dbResults"); if (!host) return;
  if (q.length < 2) { host.innerHTML = '<p class="hint" style="margin-top:10px">Type at least two letters.</p>'; return; }
  const seq = ++searchSeq;
  dbCache = {};
  host.innerHTML = '<h4>Generic foods · USDA</h4><div id="usdaBox"><div class="spin"></div></div><h4>Brands · Open Food Facts</h4><div id="offBox"><div class="spin"></div></div>';
  const fill = (boxId, list, what) => {
    if (seq !== searchSeq) return;
    const box = $(boxId); if (!box) return;
    if (list instanceof Error || (list && list.kind)) { box.innerHTML = '<p class="err" style="padding:8px 0">'+esc(netError(list, what))+'</p>'; return; }
    if (!list.length) { box.innerHTML = '<p class="hint" style="padding:8px 0">No matches.</p>'; return; }
    list.forEach(f => { dbCache[f.id] = f; });
    box.innerHTML = '<ul class="results">' + list.map(f => foodRow(f, {db:true})).join("") + '</ul>';
  };
  searchUSDA(q).then(l => fill("usdaBox", l, "the USDA database"), e => fill("usdaBox", e, "the USDA database"));
  searchOFF(q).then(l => fill("offBox", l, "Open Food Facts"), e => fill("offBox", e, "Open Food Facts"));
}

/* --- settings --- */
function showSettings(){
  const g = DB.targets || {};
  const s = DB.settings;
  const nFoods = Object.keys(DB.foods).length, nDays = Object.keys(DB.days).length;
  const lb = s.lastBackup ? new Date(s.lastBackup).toLocaleDateString(undefined,{month:"short",day:"numeric"}) : null;
  openSheet(
    '<h3>Settings</h3>'
    + '<form class="stack" id="tForm" novalidate>'
    + '<h4>Daily targets</h4>'
    + '<div class="field"><label for="tK">Calories</label><input id="tK" inputmode="numeric" value="'+(g.kcal||"")+'"></div>'
    + '<div class="row2"><div class="field"><label for="tP">Protein (g)</label><input id="tP" inputmode="numeric" value="'+(g.p||"")+'"></div>'
    + '<div class="field"><label for="tC">Carbs (g)</label><input id="tC" inputmode="numeric" value="'+(g.c||"")+'"></div></div>'
    + '<div class="field"><label for="tF">Fat (g)</label><input id="tF" inputmode="numeric" value="'+(g.f||"")+'"></div>'
    + '<p class="hint" id="tHint"></p>'
    + '<h4>USDA search key</h4>'
    + '<div class="field"><label for="uKey">API key (optional)</label><input id="uKey" value="'+esc(s.usdaKey||"")+'" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Using the shared demo key"></div>'
    + '<p class="hint">The shared demo key allows only a few dozen searches an hour. A free personal key from <a href="https://fdc.nal.usda.gov/api-key-signup.html" target="_blank" rel="noopener" style="color:var(--accent)">fdc.nal.usda.gov</a> removes that limit.</p>'
    + '<button class="btn primary" type="submit">Save settings</button>'
    + '</form>'
    + '<div class="stack" style="margin-top:18px">'
    + '<h4>Backup</h4>'
    + '<p class="hint">Your log lives only on this phone: '+nDays+' day'+(nDays===1?'':'s')+' logged, '+nFoods+' saved food'+(nFoods===1?'':'s')+'. '+(lb ? 'Last backup '+lb+'.' : 'No backup yet.')+' Save a backup file now and then (to iCloud Drive or Google Drive) so you can restore it on a new phone.</p>'
    + '<div class="row2"><button class="btn" type="button" data-act="export">Save backup</button><button class="btn" type="button" data-act="import">Restore backup</button></div>'
    + '<button class="linkish" type="button" data-act="close">Close</button>'
    + '</div>');
  const hint = () => {
    const p=num($("tP").value), c=num($("tC").value), f=num($("tF").value), k=num($("tK").value);
    const m = r0(p*4 + c*4 + f*9);
    $("tHint").textContent = m ? "Your macros add up to " + fmt(m) + " kcal" + (k ? " (" + (m>=k ? fmt(m-k)+" above" : fmt(k-m)+" below") + " your calorie target)." : ".") : "Protein and carbs are 4 kcal per gram, fat is 9.";
  };
  ["tK","tP","tC","tF"].forEach(id => $(id).addEventListener("input", hint)); hint();
  $("tForm").addEventListener("submit", ev => {
    ev.preventDefault();
    const t = { kcal: r0(num($("tK").value)), p: r0(num($("tP").value)), c: r0(num($("tC").value)), f: r0(num($("tF").value)) };
    DB.targets = t.kcal || t.p || t.c || t.f ? t : null;
    DB.settings.usdaKey = $("uKey").value.trim();
    save(); closeSheet(); render(); toast("Settings saved");
  });
}
async function exportBackup(){
  const name = "fuel-ledger-backup-" + keyOf(new Date()) + ".json";
  const body = JSON.stringify({ app: "fuel-ledger", version: 1, exported: new Date().toISOString(), data: DB });
  const file = new File([body], name, { type: "application/json" });
  let ok = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Fuel Ledger backup" }); ok = true; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  if (!ok) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    ok = true;
  }
  DB.settings.lastBackup = Date.now(); save();
  toast("Backup saved");
}
$("importInput").addEventListener("change", async e => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    const d = j && j.data ? j.data : j;
    if (!d || typeof d !== "object" || (!d.days && !d.foods)) throw 0;
    const nDays = Object.keys(d.days || {}).length, nFoods = Object.keys(d.foods || {}).length;
    openSheet('<h3>Restore this backup?</h3><p class="lead">It has '+nDays+' logged days and '+nFoods+' saved foods. Restoring replaces everything currently on this phone.</p><div class="stack"><button class="btn primary" type="button" data-act="confirm-import">Replace with backup</button><button class="linkish" type="button" data-act="close">Cancel</button></div>', { importData: d });
  } catch {
    openSheet('<h3>That file isn\'t a backup</h3><p class="lead">Choose a file named like fuel-ledger-backup-2026-11-03.json, saved from this app\'s Settings.</p><button class="btn" type="button" data-act="close" style="width:100%">OK</button>');
  }
});

/* --- typed barcode --- */
function showTypeCode(lead){
  openSheet('<h3>Type a barcode</h3><p class="lead">'+esc(lead || "Enter the digits printed under the barcode.")+'</p><form class="stack" id="cForm" novalidate><div class="field"><label for="cIn">Barcode number</label><input id="cIn" inputmode="numeric" enterkeyhint="search" placeholder="e.g. 041570110676"></div><p class="err" id="cErr" hidden></p><button class="btn primary" type="submit">Look up</button><button class="linkish" type="button" data-act="close">Cancel</button></form>');
  setTimeout(() => { const i = $("cIn"); if (i) i.focus(); }, 50);
  $("cForm").addEventListener("submit", ev => {
    ev.preventDefault();
    const code = normCode($("cIn").value);
    if (code.length < 8) { $("cErr").textContent = "That looks too short. Barcodes are usually 8, 12 or 13 digits."; $("cErr").hidden = false; return; }
    handleCode(code);
  });
}

/* ================= barcode flow ================= */
async function handleCode(code){
  const known = DB.foods["upc"+code] || Object.values(DB.foods).find(f => f.code === code);
  if (known) { showLog(known); return; }
  const me = busy("Looking it up", "Checking Open Food Facts for barcode " + code + "…");
  let found;
  try { found = await lookupBarcode(code); }
  catch (e) {
    if (ctx !== me) return;
    showFoodForm({ code }, { title: "Enter it manually", lead: esc(netError(e, "Open Food Facts")) + " You can enter the label numbers instead.", logAfter: true });
    return;
  }
  if (ctx !== me) return;   // user cancelled
  if (found && !found.incomplete) { showLog(found); return; }
  showFoodForm({ code, name: found ? found.name : "", brand: found ? found.brand : "" }, {
    title: found ? "Missing nutrition info" : "Product not found",
    lead: (found ? "Open Food Facts has this product but not its nutrition numbers." : "Barcode " + esc(code) + " isn't in Open Food Facts yet.") + " Enter the per-serving numbers from the label once and it will log instantly next time.",
    logAfter: true, offLink: true
  });
}

/* --- live camera scanner --- */
let stopScan = null, torchTrack = null, torchOn = false;
async function openScanner(){
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showTypeCode(location.protocol !== "https:" && location.hostname !== "localhost"
      ? "The camera only works when the app is opened over https. Type the number for now."
      : "This browser can't open the camera. Type the barcode number instead.");
    return;
  }
  const video = $("video");
  $("scanMsg").textContent = "Line up the barcode inside the box";
  $("torchBtn").hidden = true; torchOn = false; torchTrack = null;
  $("scanner").hidden = false;
  let done = false, last = "", hits = 0;
  const onRead = (raw, isUpcE) => {
    if (done) return;
    const code = normCode(raw, isUpcE);
    const valid = checkDigitOk(code);
    if (code === last) hits++; else { last = code; hits = 1; }
    if ((valid && hits >= 2) || hits >= 4) {
      done = true;
      if (navigator.vibrate) navigator.vibrate(60);
      closeScanner();
      handleCode(code);
    }
  };
  const constraints = { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } };
  try {
    let native = false;
    if ("BarcodeDetector" in window) {
      try { const f = await BarcodeDetector.getSupportedFormats(); native = f.includes("ean_13") && f.includes("upc_a"); } catch {}
    }
    if (native) {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play().catch(() => {});
      const fmts = ["ean_13","ean_8","upc_a","upc_e"];
      const bd = new BarcodeDetector({ formats: fmts });
      let alive = true;
      const tick = async () => {
        if (!alive) return;
        try { const r = await bd.detect(video); if (r && r[0]) onRead(r[0].rawValue, r[0].format === "upc_e"); } catch {}
        if (alive) setTimeout(tick, 120);
      };
      tick();
      stopScan = () => { alive = false; stream.getTracks().forEach(t => t.stop()); video.srcObject = null; };
      setupTorch(stream);
    } else {
      const Z = window.ZXing;
      if (!Z) throw Object.assign(new Error("nolib"), { name: "NoLib" });
      const hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
      hints.set(Z.DecodeHintType.TRY_HARDER, true);
      const reader = new Z.BrowserMultiFormatReader(hints, 120);
      stopScan = () => { try { reader.reset(); } catch {} if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; } };
      await reader.decodeFromConstraints(constraints, video, res => {
        if (res) onRead(res.getText(), res.getBarcodeFormat() === Z.BarcodeFormat.UPC_E);
      });
      if (video.srcObject) setupTorch(video.srcObject);
    }
  } catch (e) {
    closeScanner();
    const n = e && e.name;
    const lead = n === "NotAllowedError" || n === "SecurityError"
      ? "Camera access is turned off for this app. Turn it on in your browser or phone settings, or type the number."
      : n === "NotFoundError" || n === "OverconstrainedError" ? "No camera was found. Type the barcode number instead."
      : "The camera couldn't start. Close other apps using it and try again, or type the number.";
    showTypeCode(lead);
  }
}
function setupTorch(stream){
  const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
  if (!track || !track.getCapabilities) return;
  setTimeout(() => {
    try { if (track.getCapabilities().torch) { torchTrack = track; $("torchBtn").hidden = false; } } catch {}
  }, 400);
}
function closeScanner(){
  if (stopScan) { stopScan(); stopScan = null; }
  $("scanner").hidden = true;
}
$("torchBtn").addEventListener("click", async () => {
  if (!torchTrack) return;
  torchOn = !torchOn;
  try { await torchTrack.applyConstraints({ advanced: [{ torch: torchOn }] }); $("torchBtn").textContent = torchOn ? "Flashlight off" : "Flashlight"; } catch { torchOn = !torchOn; }
});
$("closeScan").addEventListener("click", closeScanner);
$("typeCodeBtn").addEventListener("click", () => { closeScanner(); showTypeCode(); });

/* ================= events ================= */
$("scanBtn").addEventListener("click", openScanner);
$("addBtn").addEventListener("click", () => showSearch(""));
$("settingsBtn").addEventListener("click", showSettings);
$("prevDay").addEventListener("click", () => { const d = fromKey(date); d.setDate(d.getDate()-1); date = keyOf(d); render(); });
$("nextDay").addEventListener("click", () => { const d = fromKey(date); d.setDate(d.getDate()+1); const k = keyOf(d); if (k <= keyOf(new Date())) { date = k; render(); } });
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!$("scanner").hidden) closeScanner(); else if (!$("sheet").hidden) closeSheet(); } });
document.addEventListener("input", e => { if (e.target.id === "amt") updatePreview(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden && !$("scanner").hidden) closeScanner();
  if (!document.hidden) { const t = keyOf(new Date()); if (date > t) date = t; render(); }
});

document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act;
  if (act === "close") closeSheet();
  else if (act === "open-settings") showSettings();
  else if (act === "new-food") showFoodForm({ code: (ctx.editing && ctx.editing.code) || "" }, { logAfter: true });
  else if (act === "pick") { const f = DB.foods[b.dataset.id]; if (f) showLog(f); }
  else if (act === "pick-db") { const f = DB.foods[b.dataset.id] || dbCache[b.dataset.id]; if (f) showLog(f); }
  else if (act === "edit") { const f = DB.foods[b.dataset.id]; if (f) showFoodForm(f); }
  else if (act === "edit-food") { if (ctx.food) showFoodForm(ctx.food, { logAfter: true }); }
  else if (act === "del-food") {
    const f = ctx.editing;
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Tap again to delete " + (f && f.name ? f.name : "this food"); return; }
    if (f && f.id) { delete DB.foods[f.id]; save(); }
    showSearch("");
  }
  else if (act === "meal") {
    ctx.meal = b.dataset.meal;
    b.parentElement.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  }
  else if (act === "unit") {
    const unit = b.dataset.unit; if (unit === ctx.unit) return;
    const f = ctx.food, inp = $("amt"), cur = num(inp.value);
    const g = f.servingG || 100;
    inp.value = unit === "g" ? String(r0(cur * g)) : String(r1(cur / g) || 1);
    ctx.unit = unit;
    $("amtLabel").textContent = unit === "g" ? "Grams" : "Servings";
    b.parentElement.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    updatePreview();
  }
  else if (act === "step") {
    const inp = $("amt"), step = ctx.unit === "g" ? 10 : 0.5;
    inp.value = String(Math.max(ctx.unit === "g" ? 1 : 0.25, r1(num(inp.value) + Number(b.dataset.d) * step)));
    updatePreview();
  }
  else if (act === "do-log") {
    const food = ctx.food, amt = num($("amt").value);
    if (!food || !amt) { toast("Enter an amount first"); return; }
    const vals = compute(food, amt, ctx.unit);
    const amountLabel = ctx.unit === "g" ? r1(amt) + " g" : r1(amt) + " × " + (food.serving || "serving");
    const list = dayEntries().slice();
    list.push({ id: uid(), foodId: food.id, name: food.name, brand: food.brand || "", amount: r1(amt), unit: ctx.unit, amountLabel, meal: ctx.meal || defaultMeal(), ...vals, t: Date.now() });
    DB.foods[food.id] = { ...(DB.foods[food.id] || food), lastUsed: Date.now() };
    setDayEntries(list);
    closeSheet(); render(); toast("Logged " + food.name);
  }
  else if (act === "del-entry") {
    if (b.dataset.confirm !== "1") {
      b.dataset.confirm = "1"; b.textContent = "✓"; b.setAttribute("aria-label", "Tap again to remove");
      setTimeout(() => { if (b.isConnected) { b.dataset.confirm = ""; b.textContent = "×"; } }, 2500);
      return;
    }
    setDayEntries(dayEntries().filter(x => x.id !== b.dataset.id));
    render();
  }
  else if (act === "export") exportBackup();
  else if (act === "import") { $("importInput").value = ""; $("importInput").click(); }
  else if (act === "confirm-import") {
    const d = ctx.importData; if (!d) return;
    const b0 = blank();
    DB = { ...b0, ...d, settings: { ...b0.settings, ...(d.settings || {}) }, foods: d.foods || {}, days: d.days || {} };
    save(); closeSheet(); render(); toast("Backup restored");
  }
  else if (act === "install") { if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; $("installBanner").hidden = true; } }
  else if (act === "hide-install") { DB.settings.hideInstall = true; save(); $("installBanner").hidden = true; }
});

/* ================= install + offline ================= */
let deferredPrompt = null;
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function showInstallBanner(){
  if (standalone() || DB.settings.hideInstall) return;
  const el = $("installBanner");
  if (isIOS) {
    el.innerHTML = '<b>Add Fuel Ledger to your Home Screen.</b> In Safari, tap Share, then Add to Home Screen. It opens full screen, and iPhone keeps your log saved. <button type="button" data-act="hide-install">Dismiss</button>';
    el.hidden = false;
  } else if (deferredPrompt) {
    el.innerHTML = '<b>Install Fuel Ledger</b> so it opens like an app and works offline. <button type="button" data-act="install">Install</button> · <button type="button" data-act="hide-install">Dismiss</button>';
    el.hidden = false;
  }
}
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredPrompt = e; showInstallBanner(); });
if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

render();
showInstallBanner();
})();

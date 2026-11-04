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
function blank(){ return { targets: null, profiles: [], activeProfile: null, foods: {}, days: {}, settings: { usdaKey: "", lastBackup: 0, hideInstall: false } }; }
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
  const dayName = isToday ? "Today" : date === yest ? "Yesterday" : d.toLocaleDateString(undefined, {weekday:"long"});
  $("dateLabel").textContent = dayName + " · " + d.toLocaleDateString(undefined, {month:"short", day:"numeric"});
  $("nextDay").disabled = isToday;

  const t = totals(list), g = DB.targets;
  if (g && g.kcal) {
    const left = g.kcal - t.kcal;
    $("heroNum").textContent = fmt(Math.abs(left));
    $("heroUnit").textContent = left >= 0 ? "calories left" : "calories over";
    $("heroFill").style.width = Math.min(100, t.kcal / g.kcal * 100) + "%";
    $("heroBar").hidden = false;
    $("heroLeft").textContent = fmt(t.kcal) + " eaten";
    $("heroRight").textContent = fmt(g.kcal) + " goal";
  } else {
    $("heroNum").textContent = fmt(t.kcal);
    $("heroUnit").textContent = "calories eaten";
    $("heroBar").hidden = true;
    $("heroLeft").textContent = list.length + (list.length === 1 ? " item" : " items") + " logged";
    $("heroRight").innerHTML = '<button type="button" data-act="open-settings">Set daily targets</button>';
  }

  $("tiles").innerHTML = [["Protein","p","protein"],["Carbs","c","carbs"],["Fat","f","fat"]].map(([label,k,col]) => {
    const tgt = g && g[k] ? g[k] : 0;
    const pct = tgt ? Math.min(100, t[k] / tgt * 100) : 0;
    return '<div class="tile"><div class="v">'+r0(t[k])+'</div><div class="of">'+(tgt ? '/ '+tgt+' g' : 'grams')+'</div>'
      + '<div class="k" style="color:var(--'+col+')">'+label+'</div>'
      + (tgt ? '<div class="tb"><i style="width:'+pct+'%;background:var(--'+col+')"></i></div>' : '')+'</div>';
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
/* --- target editor: change one number, the rest rebalance --- */
const KCAL_PER_G = { p: 4, c: 4, f: 9 };
const MACRO_META = [["p","Protein","protein",5],["c","Carbs","carbs",5],["f","Fat","fat",2]];
// Returns a new {kcal,p,c,f} after one field changes, plus a note when the request couldn't be met exactly.
function rebalance(base, field, val, locks, keepCal){
  const t = { ...base, [field]: Math.max(0, Math.round(val)) };
  const macroKcal = x => x.p*4 + x.c*4 + x.f*9;
  if (field === "kcal") {
    const free = ["p","c","f"].filter(k => !locks[k]);
    const fixed = ["p","c","f"].filter(k => locks[k]).reduce((s,k) => s + t[k]*KCAL_PER_G[k], 0);
    let room = t.kcal - fixed;
    if (!free.length) return { t: { ...t, kcal: macroKcal(t) }, note: "All macros are locked, so calories follow them." };
    if (room < 0) { free.forEach(k => t[k] = 0); return { t: { ...t, kcal: fixed }, note: "Locked macros already need " + fmt(fixed) + " kcal, so calories can't go lower." }; }
    const cur = free.reduce((s,k) => s + base[k]*KCAL_PER_G[k], 0);
    free.forEach(k => { const share = cur ? base[k]*KCAL_PER_G[k] / cur : 1/free.length; t[k] = Math.round(room * share / KCAL_PER_G[k]); });
    fixRounding(t, free);
    return { t, note: "" };
  }
  if (!keepCal) return { t: { ...t, kcal: macroKcal(t) }, note: "" };
  const others = ["p","c","f"].filter(k => k !== field && !locks[k]);
  if (!others.length) return { t: { ...t, kcal: macroKcal(t) }, note: "The other macros are locked, so calories changed instead." };
  const need = (t[field] - base[field]) * KCAL_PER_G[field];        // kcal the others must give up (or receive)
  const pool = others.reduce((s,k) => s + base[k]*KCAL_PER_G[k], 0);
  let note = "";
  if (need > pool) {                                                // not enough left to take from
    others.forEach(k => t[k] = 0);
    t.kcal = macroKcal(t);
    note = "There wasn't enough left in " + others.map(k => MACRO_META.find(m => m[0]===k)[1].toLowerCase()).join(" and ") + ", so calories went up.";
    return { t, note };
  }
  others.forEach(k => {
    const share = pool ? base[k]*KCAL_PER_G[k] / pool : 1/others.length;
    t[k] = Math.max(0, Math.round((base[k]*KCAL_PER_G[k] - need*share) / KCAL_PER_G[k]));
  });
  fixRounding(t, others);
  return { t, note };
}
function fixRounding(t, adjustable){
  // Nudge one adjustable macro so the macros land within a few kcal of the calorie target.
  const prefer = ["c","p","f"].filter(k => adjustable.includes(k));
  if (!prefer.length) return;
  const k = prefer[0];
  const diff = t.kcal - (t.p*4 + t.c*4 + t.f*9);
  t[k] = Math.max(0, t[k] + Math.round(diff / KCAL_PER_G[k]));
}
function targetEditorHTML(g){
  const lockSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  const row = (key, label, col, step, val, unit) =>
    '<div class="trow" data-row="'+key+'"><div class="tl"><b'+(col?' style="color:var(--'+col+')"':'')+'>'+label+'</b><small id="tPct_'+key+'"></small></div>'
    + '<div class="tctl"><button type="button" class="tstep" data-tstep="'+key+'" data-d="-'+step+'" aria-label="Less '+label+'">−</button>'
    + '<input id="t_'+key+'" data-tkey="'+key+'" inputmode="numeric" value="'+(val||"")+'" aria-label="'+label+' '+unit+'"><span class="tu">'+unit+'</span>'
    + '<button type="button" class="tstep" data-tstep="'+key+'" data-d="'+step+'" aria-label="More '+label+'">+</button>'
    + (key === "kcal" ? '<span class="tlock-sp"></span>' : '<button type="button" class="tlock" data-tlock="'+key+'" aria-pressed="false" aria-label="Lock '+label+'">'+lockSvg+'</button>')
    + '</div></div>';
  return '<div class="teditor">'
    + row("kcal","Calories","",50,g.kcal,"kcal")
    + MACRO_META.map(([k,l,col,st]) => row(k,l,col,st,g[k],"g")).join("")
    + '</div>'
    + '<label class="tkeep"><input type="checkbox" id="tKeep" checked> Keep calories the same when I change a macro</label>'
    + '<p class="hint" id="tHint"></p>';
}
function wireTargetEditor(g){
  let t = { kcal: num(g.kcal), p: num(g.p), c: num(g.c), f: num(g.f) };
  const locks = { p: false, c: false, f: false };
  let base = null, note = "";
  const paint = (skip) => {
    ["kcal","p","c","f"].forEach(k => { const el = $("t_"+k); if (el && k !== skip) el.value = t[k] ? String(t[k]) : ""; });
    const m = t.p*4 + t.c*4 + t.f*9;
    MACRO_META.forEach(([k]) => { const el = $("tPct_"+k); if (el) el.textContent = m ? Math.round(t[k]*KCAL_PER_G[k]/m*100) + "% of calories" : ""; });
    const diff = m - t.kcal;
    const status = !m ? "Protein and carbs are 4 kcal per gram, fat is 9."
      : !t.kcal ? "Your macros add up to " + fmt(m) + " kcal."
      : Math.abs(diff) <= 10 ? "Macros add up to " + fmt(m) + " kcal, matching your calorie target."
      : "Macros add up to " + fmt(m) + " kcal (" + fmt(Math.abs(diff)) + (diff > 0 ? " above" : " below") + " your calorie target).";
    $("tHint").textContent = note ? note + " " + status : status;
  };
  const apply = (key, val, skip) => {
    if (!base) base = { ...t };
    const keep = $("tKeep").checked;
    const blank = !base.kcal && !base.p && !base.c && !base.f;
    if (blank && key !== "kcal") { t = { ...t, [key]: Math.max(0, Math.round(val)) }; t.kcal = t.p*4 + t.c*4 + t.f*9; note = ""; }
    else { const r = rebalance(base, key, val, locks, keep); t = r.t; note = r.note; }
    paint(skip);
  };
  const box = document.querySelector(".teditor");
  box.addEventListener("focusin", e => { if (e.target.dataset.tkey) base = { ...t }; });
  box.addEventListener("input", e => { const k = e.target.dataset.tkey; if (k) apply(k, num(e.target.value), k); });
  box.addEventListener("focusout", e => { if (e.target.dataset.tkey) { base = null; paint(); } });
  box.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.tstep) {
      const k = b.dataset.tstep;
      base = { ...t };
      apply(k, t[k] + Number(b.dataset.d));
      base = null;
    } else if (b.dataset.tlock) {
      const k = b.dataset.tlock;
      locks[k] = !locks[k];
      b.setAttribute("aria-pressed", String(locks[k]));
      b.closest(".trow").classList.toggle("locked", locks[k]);
    }
  });
  $("tKeep").addEventListener("change", () => { note = ""; paint(); });
  paint();
  return { value: () => ({ kcal: r0(t.kcal), p: r0(t.p), c: r0(t.c), f: r0(t.f) }) };
}

function showSettings(){
  const g = DB.targets || {};
  const s = DB.settings;
  const nFoods = Object.keys(DB.foods).length, nDays = Object.keys(DB.days).length;
  const lb = s.lastBackup ? new Date(s.lastBackup).toLocaleDateString(undefined,{month:"short",day:"numeric"}) : null;
  openSheet(
    '<h3>Settings</h3>'
    + '<form class="stack" id="tForm" novalidate>'
    + '<h4>Daily targets</h4>'
    + (DB.profiles && DB.profiles.length
        ? '<div class="field"><label>Saved profiles</label><div class="seg" role="group" aria-label="Saved profiles">'
          + DB.profiles.map(p => '<button type="button" data-act="apply-profile" data-id="'+esc(p.id)+'" aria-pressed="'+(DB.activeProfile===p.id)+'">'+esc(p.name)+'</button>').join("")
          + '</div></div>'
        : '')
    + '<button class="btn" type="button" data-act="open-calc">'+(DB.profiles && DB.profiles.length ? 'Recalculate my targets' : 'Calculate my targets')+'</button>'
    + '<p class="hint">Answer a few questions about your body and activity, or type your own numbers below.</p>'
    + targetEditorHTML(g)
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
  const editor = wireTargetEditor(g);
  $("tForm").addEventListener("submit", ev => {
    ev.preventDefault();
    const t = editor.value();
    const prev = DB.targets || {};
    if (t.kcal !== prev.kcal || t.p !== prev.p || t.c !== prev.c || t.f !== prev.f) DB.activeProfile = null;   // hand-edited numbers no longer match a profile
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

/* --- target calculator --- */
// MET values from the Compendium of Physical Activities. Net cost = (MET - 1) x kg x hours,
// because resting burn is already counted in the baseline.
const CARDIO = {
  walk: ["Brisk walking", 4.3], run: ["Running", 9.8], bike: ["Cycling", 7], ellip: ["Elliptical", 5],
  stair: ["Stair climber", 9], row: ["Rowing", 7], swim: ["Swimming", 6], hiit: ["HIIT class", 8], sport: ["Basketball or other sports", 6.5]
};
const ON_FEET = {
  sit: ["Mostly sitting", 4000], some: ["On my feet some", 7000], most: ["On my feet most of the day", 11000], phys: ["Physical job, walking all day", 15000]
};
const GOALS = {
  cut: { label: "Lose fat", paces: { slow: [-0.10, "Steady"], fast: [-0.20, "Faster"] }, protein: 1.0 },
  maintain: { label: "Maintain", paces: null, protein: 0.8 },
  bulk: { label: "Build muscle", paces: { slow: [0.05, "Lean"], fast: [0.10, "Faster"] }, protein: 0.9 }
};
function defaultCalc(){
  return { name: "My targets", sex: "m", age: "", ft: "", inch: "", lb: "", stepsMode: "est", steps: "", onFeet: "some",
           liftDays: 4, liftMin: 60, liftHard: true, cardio: [], goal: "maintain", pace: "slow" };
}
function computeTargets(x){
  const age = num(x.age), lb = num(x.lb), heightIn = num(x.ft) * 12 + num(x.inch);
  if (!age || !lb || !heightIn) return null;
  const kg = lb * 0.4536, cm = heightIn * 2.54;
  const resting = 10*kg + 6.25*cm - 5*age + (x.sex === "f" ? -161 : 5);       // Mifflin-St Jeor
  const living = resting * 0.2;                                                // basic daily living + digesting food
  const steps = x.stepsMode === "known" ? num(x.steps) : ON_FEET[x.onFeet][1];
  const stepsK = Math.max(0, steps - 3000) * lb * 0.0002;                      // ~0.4 kcal per lb per mile, 2,000 steps a mile
  const liftK = (x.liftHard ? 5 : 2.5) * kg * (num(x.liftMin) / 60) * num(x.liftDays) / 7;
  const cardioK = (x.cardio || []).reduce((s, c) => s + ((CARDIO[c.type] || CARDIO.walk)[1] - 1) * kg * (num(c.min) / 60), 0) / 7;
  const maintenance = resting + living + stepsK + liftK + cardioK;
  const goal = GOALS[x.goal] || GOALS.maintain;
  const pct = goal.paces ? goal.paces[x.pace in goal.paces ? x.pace : "slow"][0] : 0;
  let kcal = maintenance * (1 + pct), floored = false;
  if (kcal < resting) { kcal = resting; floored = true; }
  kcal = Math.round(kcal / 10) * 10;
  const p = Math.min(Math.round(lb * goal.protein), Math.round(kcal * 0.35 / 4));
  const f = Math.max(Math.round(kcal * 0.27 / 9), Math.round(lb * 0.3));
  const c = Math.max(0, Math.round((kcal - p*4 - f*9) / 4));
  return { kcal, p, c, f, floored, pct,
    parts: { resting: r0(resting), living: r0(living), steps: r0(stepsK), lifting: r0(liftK), cardio: r0(cardioK), maintenance: r0(maintenance), adjust: r0(kcal - maintenance) } };
}
function showCalculator(prefill){
  const x = { ...defaultCalc(), ...(DB.settings.calcInputs || {}), ...(prefill || {}) };
  x.cardio = (x.cardio || []).map(c => ({ ...c }));
  const seg = (key, opts) => '<div class="seg" role="group">' + opts.map(([v, l]) => '<button type="button" data-calc="'+key+'" data-v="'+v+'" aria-pressed="'+(String(x[key])===String(v))+'">'+esc(l)+'</button>').join("") + '</div>';
  const inp = (id, key, label, ph) => '<div class="field"><label for="'+id+'">'+label+'</label><input id="'+id+'" data-key="'+key+'" inputmode="decimal" value="'+esc(x[key])+'" placeholder="'+(ph||"")+'"></div>';
  const cardioRows = () => x.cardio.map((c, i) => '<div class="row2" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto;align-items:end">'
      + '<div class="field"><label for="ct'+i+'">Cardio</label><select id="ct'+i+'" data-cardio="'+i+'" data-f="type">'
      + Object.entries(CARDIO).map(([k, v]) => '<option value="'+k+'"'+(c.type===k?' selected':'')+'>'+v[0]+'</option>').join("") + '</select></div>'
      + '<div class="field"><label for="cm'+i+'">Minutes / week</label><input id="cm'+i+'" data-cardio="'+i+'" data-f="min" inputmode="numeric" value="'+esc(c.min)+'"></div>'
      + '<button type="button" class="ed" data-calc-del="'+i+'" aria-label="Remove" style="height:42px;padding:0 12px">×</button></div>').join("");

  openSheet(
    '<h3>Calculate my targets</h3><p class="lead">The more accurate your activity answers, the closer the estimate.</p>'
    + '<div class="stack" id="calc">'
    + '<h4>About you</h4>'
    + '<div class="field"><label>Sex</label>'+seg("sex", [["m","Male"],["f","Female"]])+'</div>'
    + '<div class="row2">'+inp("cAge","age","Age")+inp("cLb","lb","Weight (lb)")+'</div>'
    + '<div class="row2">'+inp("cFt","ft","Height (ft)","5")+inp("cIn","inch","Height (in)","10")+'</div>'
    + '<h4>Daily movement</h4>'
    + '<div class="field"><label>Steps</label>'+seg("stepsMode", [["known","I know my daily steps"],["est","Estimate for me"]])+'</div>'
    + '<div id="stepsKnown"'+(x.stepsMode==="known"?'':' hidden')+'>'+inp("cSteps","steps","Average steps per day","8000")
    + '<p class="hint" style="margin-top:6px">Check the Health app for your weekly average. If it counts your runs, don\'t add them again as cardio.</p></div>'
    + '<div id="stepsEst"'+(x.stepsMode==="est"?'':' hidden')+'>'+seg("onFeet", Object.entries(ON_FEET).map(([k,v]) => [k, v[0]]))+'</div>'
    + '<h4>Lifting</h4>'
    + '<div class="row2">'+inp("cLd","liftDays","Sessions / week")+inp("cLm","liftMin","Minutes / session")+'</div>'
    + '<div class="field"><label>Intensity</label>'+seg("liftHard", [["true","Hard, short rests"],["false","Moderate, long rests"]])+'</div>'
    + '<h4>Cardio</h4><div class="stack" id="cardioRows">'+cardioRows()+'</div>'
    + '<button class="linkish" type="button" data-calc-add="1">+ Add cardio</button>'
    + '<h4>Goal</h4>'
    + seg("goal", Object.entries(GOALS).map(([k,v]) => [k, v.label]))
    + '<div id="paceBox"></div>'
    + '<div class="tile" id="calcOut" style="background:var(--paper);margin-top:6px"></div>'
    + '<div class="field"><label for="cName">Save as profile</label><input id="cName" data-key="name" value="'+esc(x.name)+'" placeholder="Semester"></div>'
    + '<p class="hint" style="margin-top:-4px">Give each season its own name, like Semester or Summer, and switch between them in Settings.</p>'
    + '<p class="err" id="calcErr" hidden></p>'
    + '<button class="btn primary" type="button" id="calcUse">Use these targets</button>'
    + '<button class="linkish" type="button" data-act="open-settings">Back to settings</button>'
    + '</div>');

  const box = $("calc");
  const renderPace = () => {
    const g = GOALS[x.goal];
    $("paceBox").innerHTML = g.paces ? '<div class="field" style="margin-top:4px"><label>Pace</label><div class="seg" role="group">'
      + Object.entries(g.paces).map(([k, v]) => '<button type="button" data-calc="pace" data-v="'+k+'" aria-pressed="'+(x.pace===k)+'">'+v[1]+' ('+(v[0]>0?'+':'')+Math.round(v[0]*100)+'%)</button>').join("") + '</div></div>' : '';
  };
  const renderOut = () => {
    const r = computeTargets(x);
    const out = $("calcOut");
    if (!r) { out.innerHTML = '<div class="of" style="font-size:14px">Fill in age, weight and height to see your numbers.</div>'; return; }
    const row = (l, v, strong) => '<div style="display:flex;justify-content:space-between;gap:10px;font-size:14px;'+(strong?'font-weight:800;border-top:1px solid var(--line);padding-top:6px;margin-top:2px':'color:var(--muted)')+'"><span>'+l+'</span><span>'+v+'</span></div>';
    const P = r.parts;
    out.innerHTML = '<div style="display:flex;align-items:baseline;gap:8px"><span class="v" style="font-size:40px">'+fmt(r.kcal)+'</span><span class="of" style="font-size:14px">calories a day</span></div>'
      + '<div style="display:flex;gap:14px;font-weight:800;margin:6px 0 10px"><span class="p">'+r.p+'g protein</span><span class="c">'+r.c+'g carbs</span><span class="f">'+r.f+'g fat</span></div>'
      + row("Resting burn", fmt(P.resting)) + row("Daily living", "+" + fmt(P.living)) + row("Steps", "+" + fmt(P.steps))
      + row("Lifting (daily avg)", "+" + fmt(P.lifting)) + row("Cardio (daily avg)", "+" + fmt(P.cardio))
      + row("Maintenance", fmt(P.maintenance), true)
      + (x.goal !== "maintain" && P.adjust ? row(GOALS[x.goal].label + " adjustment", (P.adjust > 0 ? "+" : "−") + fmt(Math.abs(P.adjust))) : '')
      + (r.floored ? '<p class="hint" style="margin-top:8px">Your target was raised to your resting burn. Going lower than that isn\'t recommended without guidance from a doctor or dietitian.</p>' : '')
      + '<p class="hint" style="margin-top:8px">This is an estimate. Weigh yourself a few times a week; if your weight isn\'t moving the way you want after 2–3 weeks, recalculate or adjust by about 150 calories.</p>';
  };
  const redraw = () => { renderPace(); renderOut(); };

  box.addEventListener("input", e => {
    const t = e.target;
    if (t.dataset.key) x[t.dataset.key] = t.value;
    else if (t.dataset.cardio !== undefined) x.cardio[Number(t.dataset.cardio)][t.dataset.f] = t.value;
    renderOut();
  });
  box.addEventListener("change", e => {
    const t = e.target;
    if (t.dataset.cardio !== undefined) { x.cardio[Number(t.dataset.cardio)][t.dataset.f] = t.value; renderOut(); }
  });
  box.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.calc) {
      let v = b.dataset.v; if (v === "true") v = true; else if (v === "false") v = false;
      x[b.dataset.calc] = v;
      b.parentElement.querySelectorAll("button").forEach(n => n.setAttribute("aria-pressed", String(n === b)));
      if (b.dataset.calc === "stepsMode") { $("stepsKnown").hidden = v !== "known"; $("stepsEst").hidden = v !== "est"; }
      if (b.dataset.calc === "goal") x.pace = "slow";
      redraw();
    } else if (b.dataset.calcAdd) {
      if (x.cardio.length >= 5) return;
      x.cardio.push({ type: "run", min: "60" });
      $("cardioRows").innerHTML = cardioRows(); renderOut();
    } else if (b.dataset.calcDel !== undefined) {
      x.cardio.splice(Number(b.dataset.calcDel), 1);
      $("cardioRows").innerHTML = cardioRows(); renderOut();
    } else if (b.id === "calcUse") {
      const r = computeTargets(x);
      const err = $("calcErr");
      if (!r) { err.textContent = "Fill in your age, weight and height first."; err.hidden = false; return; }
      const name = (x.name || "").trim() || "My targets";
      x.name = name;
      DB.settings.calcInputs = { ...x, cardio: x.cardio.map(c => ({ ...c })) };
      DB.profiles = DB.profiles || [];
      let prof = DB.profiles.find(p => p.name.toLowerCase() === name.toLowerCase());
      const targets = { kcal: r.kcal, p: r.p, c: r.c, f: r.f };
      if (prof) { prof.inputs = DB.settings.calcInputs; prof.targets = targets; prof.name = name; }
      else { prof = { id: "p" + uid(), name, inputs: DB.settings.calcInputs, targets }; DB.profiles.push(prof); }
      DB.targets = targets; DB.activeProfile = prof.id;
      save(); render(); showSettings(); toast(name + " targets set");
    }
  });
  redraw();
}

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
  else if (act === "open-calc") {
    const prof = (DB.profiles || []).find(p => p.id === DB.activeProfile);
    showCalculator(prof ? prof.inputs : null);
  }
  else if (act === "apply-profile") {
    const prof = (DB.profiles || []).find(p => p.id === b.dataset.id);
    if (prof) { DB.targets = { ...prof.targets }; DB.activeProfile = prof.id; DB.settings.calcInputs = prof.inputs; save(); render(); showSettings(); toast(prof.name + " targets set"); }
  }
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

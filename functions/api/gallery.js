// ════════════════════════════════════════════════════════════
//  Cloudflare Pages Function:  GET /api/gallery
//  Cloudinary の Admin API でフォルダ＆画像を取得して JSON で返す。
//  秘密鍵は Cloudflare の環境変数に保管（ブラウザには出ない）。
//
//  2モード（初回ロードを軽くするため画像は遅延取得）:
//    GET /api/gallery            → 構成だけ（セクション＋フォルダ名＋色ラベル）
//    GET /api/gallery?folder=ID  → そのフォルダの中の画像だけ
//    GET /api/gallery?random=12  → 写真からランダムに 12 枚（Random ページ用）
//                                   ※ RANDOM_EXCLUDE のセクションは対象外
//
//  構成（Cloudinary 側）:
//    ルート直下のフォルダ = セクション（例: Selected Work / Experiments / iPhone Photo）
//      その中のサブフォルダ = ギャラリーのフォルダ（サイドバーに出る）
//        その中の画像 = ギャラリーの中身
//
//  並び順: フォルダ名の昇順。先頭に "01 " 等の数字を付けると順番を制御でき、
//          表示名からはその数字プレフィックスは自動で除かれます。
//
//  カラーラベル（タグ）:  画像 = m-<色>   /  フォルダ = 中の1枚に fm-<色>
//
//  必要な環境変数:  CLD_CLOUD / CLD_KEY / CLD_SECRET
// ════════════════════════════════════════════════════════════

const COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray", "grey"];

// Random ページの母集団から外すセクション（表示名・小文字。"01 old" のような
// 数字プレフィックスは無視される）。ここに足すだけで除外できます。
const RANDOM_EXCLUDE = ["old"];

function pickMarker(tags, prefix) {
  for (const t of tags || []) {
    const m = String(t).toLowerCase().match(new RegExp(`^${prefix}-([a-z]+)$`));
    if (m && COLORS.includes(m[1])) return m[1];
  }
  return null;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const displayName = (s) => s.replace(/^\d+[\s._-]+/, "");   // 先頭の "01 " 等を除去

export async function onRequestGet({ env, request, waitUntil }) {
  const cloud = env.CLD_CLOUD;
  if (!cloud || !env.CLD_KEY || !env.CLD_SECRET) {
    return json({ error: "Missing CLD_CLOUD / CLD_KEY / CLD_SECRET env vars" }, 500);
  }
  const auth = "Basic " + btoa(`${env.CLD_KEY}:${env.CLD_SECRET}`);
  const get = async (path) => {
    const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/${path}`, {
      headers: { Authorization: auth },
    });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  };
  // Admin Search API（POST）— fm-* タグの付いた画像をまとめて取得して色ラベルを引くのに使用
  const search = async (expression, nextCursor) => {
    const body = { expression, max_results: 500, with_field: ["tags"] };
    if (nextCursor) body.next_cursor = nextCursor;
    const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/resources/search`, {
      method: "POST",
      headers: { Authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`search → ${r.status}`);
    return r.json();
  };

  // ── エッジキャッシュ（今回の不具合の本丸）────────────────
  //  Pages Function のレスポンスは cache-control を付けても CDN には載らず、
  //  効くのはブラウザのキャッシュだけ。そのままだと訪問者が変わるたびに
  //  Cloudinary の Admin API を叩き、1時間あたりの上限（HTTP 420）に達する。
  //  → 取得結果を Cache API に明示的に置き、TTL の間は Cloudinary を呼ばない。
  const edgeCache = async (key, ttl, produce) => {
    const cacheKey = new Request(`https://gallery.internal/${key}`);
    let store;
    try { store = caches.default; } catch { store = null; }

    if (store) {
      const hit = await store.match(cacheKey).catch(() => null);
      if (hit) {
        const v = await hit.json().catch(() => null);
        if (v) return v;
      }
    }
    const value = await produce();
    // 空っぽ / 欠けている結果はキャッシュしない（一時的な失敗の固定化を防ぐ）
    const empty = Array.isArray(value) && !value.length;
    if (store && value && !empty && !value.__nocache) {
      const res = new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${ttl}`,
        },
      });
      const put = store.put(cacheKey, res.clone()).catch(() => {});
      if (typeof waitUntil === "function") waitUntil(put); else await put;
    }
    return value;
  };
  const TTL = 900;   // 15分（Cloudinary を叩く間隔）

  const buildImage = (r) => ({
    url: `https://res.cloudinary.com/${cloud}/image/upload/f_auto,q_auto/v${r.version}/${r.public_id}.${r.format}`,
    name: r.public_id.split("/").pop() + "." + r.format,
    marker: pickMarker(r.tags, "m"),
    w: r.width,
    h: r.height,
  });

  async function listImages(assetFolder) {
    let resources = [];
    // ① 検索API（dynamic / fixed どちらのフォルダ構成でも確実に当たる。マーカー取得と同方式）
    try {
      const esc = assetFolder.replace(/"/g, '\\"');
      const sr = await search(`asset_folder="${esc}" AND resource_type:image`);
      resources = sr.resources || [];
    } catch { /* 検索失敗時は下のフォールバックへ */ }

    // ② フォールバック: 旧来の by_asset_folder
    if (!resources.length) {
      const res = await get(
        `resources/by_asset_folder?asset_folder=${encodeURIComponent(assetFolder)}&tags=true&max_results=100`
      ).catch(() => ({ resources: [] }));
      resources = res.resources || [];
    }
    // ③ フォールバック: public_id 前方一致（fixed-folder アカウント）
    if (!resources.length) {
      const res = await get(
        `resources/image/upload?prefix=${encodeURIComponent(assetFolder + "/")}&tags=true&max_results=100`
      ).catch(() => ({ resources: [] }));
      resources = res.resources || [];
    }

    return resources.sort((a, b) =>
      a.public_id.localeCompare(b.public_id, undefined, { numeric: true })
    );
  }

  // ── モード3: ?random=N → 写真からランダムに N 枚返す ──
  //  母集団（画像一覧）はエッジにキャッシュし、抽選だけを毎回行う。
  //  → Cloudinary を叩くのは TTL ごとに1回、レスポンスは毎回違う組み合わせ。
  const randomParam = new URL(request.url).searchParams.get("random");
  if (randomParam) {
    // 公開エンドポイントなので歯止めは残す（?random=99999 のような要求への蓋）。
    // "all" は「母集団すべて」の意味。いずれも MAX_RANDOM で頭打ち。
    const MAX_RANDOM = 500;
    const n = randomParam === "all"
      ? MAX_RANDOM
      : Math.min(MAX_RANDOM, Math.max(1, parseInt(randomParam, 10) || 12));
    try {
      const pool = await edgeCache("random-pool", TTL, async () => {
        let all = [], cursor = null, pages = 0;
        do {
          const sr = await search("resource_type:image", cursor);
          all = all.concat(sr.resources || []);
          cursor = sr.next_cursor;
          pages++;
        } while (cursor && pages < 2);   // 最大 1000 枚

        // セクション/フォルダ配下の写真だけを母集団に（ルート直下の単発アップロードは除外）。
        // さらに RANDOM_EXCLUDE のセクション（old など）は丸ごと外す。
        const eligible = (r) => {
          const fp = r.asset_folder || r.public_id.split("/").slice(0, -1).join("/");
          if (!fp || !fp.includes("/")) return false;
          const sec = displayName(fp.split("/")[0]).trim().toLowerCase();
          return !RANDOM_EXCLUDE.includes(sec);
        };
        return all.filter(eligible).map(buildImage);
      });

      // Fisher–Yates でシャッフルして先頭 N 枚
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      // 抽選結果そのものはキャッシュしない（毎回違う組み合わせを返す）
      return json({ images: pool.slice(0, n) }, 200, "no-store");
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }

  // ── モード2: ?folder=ID → そのフォルダの画像だけ返す（フォルダを開いた時）──
  const folderId = new URL(request.url).searchParams.get("folder");
  if (folderId) {
    try {
      const images = await edgeCache(`folder/${encodeURIComponent(folderId)}`, TTL, async () => {
        const resources = await listImages(folderId);
        return resources.map(buildImage);
      });
      return json({ images }, 200, "public, max-age=300");
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }

  // ── モード1: 構成だけ返す（セクション＋フォルダ名＋色ラベル）──
  try {
    const built = await edgeCache("sections", TTL, async () => {
    // ルート直下のフォルダ = セクション（最重要）。
    // ここが一時的に失敗した時に「空の構成」を返すと、それがキャッシュされて
    // フォルダが消えたまま固定化してしまう → 失敗時は throw してキャッシュさせない。
    const root = await get("folders");
    const sectionDirs = (root.folders || []).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true })
    );

    // フォルダの色ラベル（fm-*）を1回の検索でまとめて取得（任意・失敗しても続行）
    const markerByFolder = {};
    try {
      const expr = COLORS.map((c) => `tags=fm-${c}`).join(" OR ");
      const sr = await search(expr);
      for (const r of sr.resources || []) {
        const m = pickMarker(r.tags, "fm");
        if (!m) continue;
        const fp = r.asset_folder || r.public_id.split("/").slice(0, -1).join("/");
        if (fp && markerByFolder[fp] == null) markerByFolder[fp] = m;
      }
    } catch { /* 検索失敗時は色ラベルなしで続行 */ }

    let degraded = false;   // サブフォルダ取得に一部でも失敗したらキャッシュしない
    const sections = [];
    for (const secDir of sectionDirs) {
      const label = displayName(secDir.name);
      const sub = await get(`folders/${encodeURIComponent(secDir.path)}`)
        .catch(() => { degraded = true; return { folders: [] }; });

      const folders = (sub.folders || [])
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((f) => ({
          id: f.path,
          name: displayName(f.name),
          marker: markerByFolder[f.path] || null,
          images: [],                       // 画像はフォルダを開いた時に取得
        }));

      sections.push({
        id: slug(secDir.name),
        label,
        allLabel: "(all)",
        allId: "all-" + slug(secDir.name),
        folders,
      });
    }

    // 中身が揃っている時だけキャッシュ（一時的な取得失敗を固定化させない）
    return { sections, __nocache: degraded || !sections.length };
    });
    return json({ sections: built.sections }, 200,
      built.__nocache ? "no-store" : "public, max-age=300");
  } catch (e) {
    // 502/504 は Cloudflare が自前のエラーページに差し替えてしまうので 503 を使う
    return json({ error: String((e && e.message) || e) }, 503, "no-store");
  }
}

function json(obj, status = 200, cache) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (cache) headers["cache-control"] = cache;
  return new Response(JSON.stringify(obj), { status, headers });
}

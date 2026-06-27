// ════════════════════════════════════════════════════════════
//  Cloudflare Pages Function:  GET /api/gallery
//  Cloudinary の Admin API でフォルダ＆画像を取得して JSON で返す。
//  秘密鍵は Cloudflare の環境変数に保管（ブラウザには出ない）。
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

function pickMarker(tags, prefix) {
  for (const t of tags || []) {
    const m = String(t).toLowerCase().match(new RegExp(`^${prefix}-([a-z]+)$`));
    if (m && COLORS.includes(m[1])) return m[1];
  }
  return null;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const displayName = (s) => s.replace(/^\d+[\s._-]+/, "");   // 先頭の "01 " 等を除去

export async function onRequestGet({ env }) {
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

  const buildImage = (r) => ({
    url: `https://res.cloudinary.com/${cloud}/image/upload/f_auto,q_auto/v${r.version}/${r.public_id}.${r.format}`,
    name: r.public_id.split("/").pop() + "." + r.format,
    marker: pickMarker(r.tags, "m"),
  });

  async function listImages(assetFolder) {
    let res = await get(
      `resources/by_asset_folder?asset_folder=${encodeURIComponent(assetFolder)}&tags=true&max_results=100`
    ).catch(() => ({ resources: [] }));
    if (!res.resources || !res.resources.length) {
      // fixed-folder アカウント用フォールバック（public_id 前方一致）
      res = await get(
        `resources/image/upload?prefix=${encodeURIComponent(assetFolder + "/")}&tags=true&max_results=100`
      ).catch(() => ({ resources: [] }));
    }
    return (res.resources || []).sort((a, b) => a.public_id.localeCompare(b.public_id));
  }

  try {
    // ルート直下のフォルダ = セクション
    const root = await get("folders").catch(() => ({ folders: [] }));
    const sectionDirs = (root.folders || []).sort((a, b) => a.name.localeCompare(b.name));

    const sections = [];
    for (const secDir of sectionDirs) {
      const label = displayName(secDir.name);
      const sub = await get(`folders/${encodeURIComponent(secDir.path)}`).catch(() => ({ folders: [] }));

      const folders = [];
      for (const f of (sub.folders || []).sort((a, b) => a.name.localeCompare(b.name))) {
        const resources = await listImages(f.path);
        let folderMarker = null;
        for (const r of resources) {
          const m = pickMarker(r.tags, "fm");
          if (m) { folderMarker = m; break; }
        }
        folders.push({
          id: f.path,
          name: displayName(f.name),
          marker: folderMarker,
          images: resources.map(buildImage),
        });
      }

      sections.push({
        id: slug(secDir.name),
        label,
        allLabel: "All " + label,
        allId: "all-" + slug(secDir.name),
        folders,
      });
    }

    return json({ sections }, 200, "public, max-age=60");
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

function json(obj, status = 200, cache) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (cache) headers["cache-control"] = cache;
  return new Response(JSON.stringify(obj), { status, headers });
}

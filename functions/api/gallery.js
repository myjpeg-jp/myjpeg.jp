// ════════════════════════════════════════════════════════════
//  Cloudflare Pages Function:  GET /api/gallery
//  Cloudinary の Admin API でフォルダ＆画像を取得して JSON で返す。
//  秘密鍵は Cloudflare の環境変数に保管（ブラウザには出ない）。
//
//  必要な環境変数（Pages → Settings → Variables and Secrets）:
//    CLD_CLOUD   … cloud name（例: xfydzgu3）
//    CLD_KEY     … API Key
//    CLD_SECRET  … API Secret（Secret として登録）
// ════════════════════════════════════════════════════════════

// セクション（＝Cloudinaryの親フォルダ）。ここだけは構成として固定。
const SECTIONS = [
  { id: "selected-work", label: "Selected Work", allLabel: "All Work",        allId: "all",     path: "Selected Work" },
  { id: "experiments",   label: "Experiments",   allLabel: "All Experiments", allId: "all-exp", path: "Experiments" },
];

const COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray", "grey"];

// tags から "prefix-色名" を探してマーカー色を返す（例: prefix="m" → "m-blue"）
function pickMarker(tags, prefix) {
  for (const t of tags || []) {
    const m = String(t).toLowerCase().match(new RegExp(`^${prefix}-([a-z]+)$`));
    if (m && COLORS.includes(m[1])) return m[1];
  }
  return null;
}

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

  try {
    const sections = [];
    for (const sec of SECTIONS) {
      // セクション直下のサブフォルダ一覧（= ギャラリーのフォルダ）
      const sub = await get(`folders/${encodeURIComponent(sec.path)}`).catch(() => ({ folders: [] }));
      const folders = [];

      for (const f of sub.folders || []) {
        const assetFolder = f.path; // 例: "Selected Work/Folder 01"

        // dynamic-folder 用。空なら fixed-folder（public_id 前方一致）でフォールバック。
        let res = await get(
          `resources/by_asset_folder?asset_folder=${encodeURIComponent(assetFolder)}&tags=true&max_results=100`
        ).catch(() => ({ resources: [] }));
        if (!res.resources || !res.resources.length) {
          res = await get(
            `resources/image/upload?prefix=${encodeURIComponent(assetFolder + "/")}&tags=true&max_results=100`
          ).catch(() => ({ resources: [] }));
        }

        const resources = (res.resources || []).sort((a, b) =>
          a.public_id.localeCompare(b.public_id)
        );

        // フォルダのマーカー: いずれかの画像の "fm-色名" タグ
        let folderMarker = null;
        for (const r of resources) {
          const m = pickMarker(r.tags, "fm");
          if (m) { folderMarker = m; break; }
        }

        folders.push({
          id: assetFolder,
          name: f.name,
          marker: folderMarker,
          images: resources.map(buildImage),
        });
      }

      sections.push({
        id: sec.id, label: sec.label, allLabel: sec.allLabel, allId: sec.allId, folders,
      });
    }

    return json({ sections }, 200, "public, max-age=60");
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}

function json(obj, status = 200, cache) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (cache) headers["cache-control"] = cache;
  return new Response(JSON.stringify(obj), { status, headers });
}

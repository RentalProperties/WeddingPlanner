(function (window) {
  const COLLECTIONS = {
    venues: "data/venues.json",
    photographers: "data/photographers.json",
    budget: "data/budget.json",
    guests: "data/guests.json",
    tables: "data/tables.json",
    checklist: "data/checklist.json",
    vendors: "data/vendors.json",
    nav: "data/nav.json",
    meta: "data/meta.json",
    timeline: "data/timeline.json",
  };

  const store = {};
  let config = { owner: "", repo: "", token: "" };
  let isDirty = false;
  const fileShas = {};
  const SNAPSHOT_KEY = "wp-data-snapshot";

  // Local snapshot of the last state we saved to / loaded from GitHub, keyed
  // by commit SHA. Lets a reload right after a save show the fresh data
  // immediately instead of waiting out GitHub's API/Pages caches.
  function readSnapshot() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeSnapshot(sha) {
    try {
      localStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({ sha, savedAt: Date.now(), data: store })
      );
    } catch (e) {
      // localStorage full or unavailable — snapshot is only an optimization
    }
  }

  function getConfig() {
    const saved = localStorage.getItem("github-config");
    if (saved) {
      try {
        config = JSON.parse(saved);
      } catch (e) {
        return null;
      }
      return config;
    }
    return null;
  }

  function setConfig(owner, repo, token) {
    config = { owner, repo, token };
    localStorage.setItem("github-config", JSON.stringify(config));
    localStorage.removeItem(SNAPSHOT_KEY);
  }

  function clearConfig() {
    config = { owner: "", repo: "", token: "" };
    localStorage.removeItem("github-config");
    localStorage.removeItem(SNAPSHOT_KEY);
  }

  async function fetchJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to fetch " + path);
    return res.json();
  }

  async function githubApiFetch(path, opts = {}, retries = 3) {
    if (!config.token) throw new Error("GitHub token not configured");
    const url = `https://api.github.com${path}`;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(url, {
          // GitHub API responses are cacheable for 60s; without no-store the
          // browser serves pre-save content on a reload right after saving.
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
            Accept: "application/vnd.github.v3+json",
          },
          ...opts,
        });
        if (!res.ok) {
          const text = await res.text();
          if (res.status === 409 && attempt < retries - 1) {
            // Conflict - wait and retry
            await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
            continue;
          }
          console.error(`GitHub API error ${res.status}:`, text);
          throw new Error(`GitHub API error ${res.status}: ${text}`);
        }
        const txt = await res.text();
        return txt ? JSON.parse(txt) : null;
      } catch (e) {
        if (attempt === retries - 1) throw e;
        // Retry on network errors
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }

  async function getFileContent(filePath, ref) {
    try {
      const refQuery = ref ? `?ref=${ref}` : "";
      const data = await githubApiFetch(
        `/repos/${config.owner}/${config.repo}/contents/${filePath}${refQuery}`
      );
      const binaryString = atob(data.content);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const content = new TextDecoder().decode(bytes);
      fileShas[filePath] = data.sha;
      return { content: JSON.parse(content), sha: data.sha };
    } catch (e) {
      console.warn("Failed to fetch from GitHub:", filePath, e.message);
      return null;
    }
  }

  async function putFileContent(filePath, content, message) {
    try {
      let sha = fileShas[filePath];

      // Always fetch fresh SHA to avoid conflicts
      try {
        const fileData = await githubApiFetch(
          `/repos/${config.owner}/${config.repo}/contents/${filePath}`
        );
        sha = fileData.sha;
        fileShas[filePath] = sha;
      } catch (e) {
        // File doesn't exist yet, that's OK
        sha = undefined;
      }

      const jsonString = JSON.stringify(content, null, 2);
      const bytes = new TextEncoder().encode(jsonString);
      const binaryString = String.fromCharCode.apply(null, bytes);
      const payload = {
        message,
        content: btoa(binaryString),
      };
      if (sha) payload.sha = sha;

      const result = await githubApiFetch(
        `/repos/${config.owner}/${config.repo}/contents/${filePath}`,
        {
          method: "PUT",
          body: JSON.stringify(payload),
        }
      );
      if (result && result.content) {
        fileShas[filePath] = result.content.sha;
      }
      if (result && result.commit) {
        writeSnapshot(result.commit.sha);
      }
      isDirty = false;
      window.dispatchEvent(new CustomEvent("data-saved"));
    } catch (e) {
      console.error("Failed to save to GitHub:", filePath, e.message);
      throw e;
    }
  }

  async function loadCollection(key, ref) {
    if (!COLLECTIONS[key]) return null;
    try {
      const cfg = getConfig();
      if (cfg && cfg.token) {
        const file = await getFileContent(COLLECTIONS[key], ref);
        if (file) {
          store[key] = file.content;
          return file.content;
        }
      }
    } catch (e) {
      console.warn("GitHub load failed for", key, e.message);
    }
    try {
      const data = await fetchJson(COLLECTIONS[key]);
      store[key] = data;
      return data;
    } catch (err) {
      console.warn("Failed to load bundled JSON for", key, err.message);
      // Don't poison the store with an empty object: the caller applies the
      // correct per-collection default (array, budget shape, timeline, etc.).
      return store[key] !== undefined ? store[key] : null;
    }
  }

  async function getHeadSha() {
    const cfg = getConfig();
    if (!cfg || !cfg.token) return null;
    try {
      const refData = await githubApiFetch(
        `/repos/${cfg.owner}/${cfg.repo}/git/refs/heads/main`
      );
      return refData.object.sha;
    } catch (e) {
      console.warn("Failed to fetch head commit:", e.message);
      return null;
    }
  }

  async function loadAll() {
    const keys = Object.keys(COLLECTIONS);

    // Fast path: if the repo head is still the commit we last saved/loaded,
    // the local snapshot IS the current data — use it directly. This avoids
    // ten contents-API reads and any cache staleness right after a save.
    const headSha = await getHeadSha();
    const snapshot = readSnapshot();
    if (headSha && snapshot && snapshot.sha === headSha && snapshot.data) {
      Object.assign(store, snapshot.data);
      const results = {};
      for (const k of keys) {
        results[k] = store[k] !== undefined ? store[k] : null;
      }
      return results;
    }

    // Otherwise load pinned to the head commit: content addressed by SHA is
    // immutable, so a cached response can never be stale.
    const results = {};
    const loaded = [];
    for (const k of keys) {
      results[k] = await loadCollection(k, headSha || undefined);
      if (results[k] !== null && results[k] !== undefined) loaded.push(k);
    }
    if (headSha && loaded.length === keys.length) {
      writeSnapshot(headSha);
    }
    return results;
  }

  async function saveCollection(key, payload) {
    if (!COLLECTIONS[key]) return;
    const bodyObj = payload === undefined ? store[key] : payload;
    if (bodyObj === undefined) return;
    if (payload !== undefined) store[key] = payload;
    const cfg = getConfig();
    if (!cfg || !cfg.token) {
      console.warn("Cannot save - GitHub not configured");
      return;
    }
    await putFileContent(COLLECTIONS[key], bodyObj, `Update ${key}`);
  }

  async function saveAllAtomic(dataToSave) {
    const cfg = getConfig();
    if (!cfg || !cfg.token) {
      console.warn("Cannot save - GitHub not configured");
      return;
    }

    try {
      // Update store with provided data
      if (dataToSave) {
        Object.assign(store, dataToSave);
      }

      // Step 1: Get current commit SHA
      const refData = await githubApiFetch(
        `/repos/${cfg.owner}/${cfg.repo}/git/refs/heads/main`
      );
      const currentCommitSha = refData.object.sha;

      // Step 2: Get current tree SHA
      const commitData = await githubApiFetch(
        `/repos/${cfg.owner}/${cfg.repo}/git/commits/${currentCommitSha}`
      );
      const currentTreeSha = commitData.tree.sha;

      // Step 3: Create blobs for all files
      const blobs = {};
      for (const [key, filePath] of Object.entries(COLLECTIONS)) {
        const content = store[key];
        if (content) {
          const jsonString = JSON.stringify(content, null, 2);
          const bytes = new TextEncoder().encode(jsonString);
          const binaryString = String.fromCharCode.apply(null, bytes);
          const blobData = await githubApiFetch(
            `/repos/${cfg.owner}/${cfg.repo}/git/blobs`,
            {
              method: "POST",
              body: JSON.stringify({
                content: btoa(binaryString),
                encoding: "base64",
              }),
            }
          );
          blobs[filePath] = {
            sha: blobData.sha,
            mode: "100644",
            type: "blob",
            path: filePath,
          };
        }
      }

      // Step 4: Create new tree with all blobs
      const treeItems = Object.values(blobs).map((blob) => ({
        path: blob.path,
        mode: blob.mode,
        type: blob.type,
        sha: blob.sha,
      }));

      const treeData = await githubApiFetch(
        `/repos/${cfg.owner}/${cfg.repo}/git/trees`,
        {
          method: "POST",
          body: JSON.stringify({
            base_tree: currentTreeSha,
            tree: treeItems,
          }),
        }
      );

      // Step 5: Create commit with new tree
      const commitMsg = `Update planning data ${new Date().toISOString()}`;
      const newCommitData = await githubApiFetch(
        `/repos/${cfg.owner}/${cfg.repo}/git/commits`,
        {
          method: "POST",
          body: JSON.stringify({
            message: commitMsg,
            tree: treeData.sha,
            parents: [currentCommitSha],
          }),
        }
      );

      // Step 6: Update ref to point to new commit
      await githubApiFetch(
        `/repos/${cfg.owner}/${cfg.repo}/git/refs/heads/main`,
        {
          method: "PATCH",
          body: JSON.stringify({
            sha: newCommitData.sha,
            force: false,
          }),
        }
      );

      writeSnapshot(newCommitData.sha);
      isDirty = false;
      window.dispatchEvent(new CustomEvent("data-saved"));
    } catch (e) {
      console.error("Failed to save atomically to GitHub:", e.message);
      throw e;
    }
  }

  async function saveAll(dataToSave) {
    const cfg = getConfig();
    if (!cfg || !cfg.token) {
      console.warn("Cannot save - GitHub not configured");
      return;
    }
    // Use atomic save (single commit with all files)
    await saveAllAtomic(dataToSave);
  }

  function get(key) {
    return store[key];
  }

  function pad(n, width = 2) {
    return String(n).padStart(width, "0");
  }

  function formatTimestampId(date) {
    return (
      "" +
      date.getFullYear() +
      pad(date.getMonth() + 1) +
      pad(date.getDate()) +
      pad(date.getHours()) +
      pad(date.getMinutes()) +
      pad(date.getSeconds())
    );
  }

  async function addItem(key, item) {
    if (!COLLECTIONS[key]) throw new Error("Unknown collection " + key);
    if (!store[key]) store[key] = [];
    if (!Array.isArray(store[key])) {
      throw new Error("Collection is not an array");
    }
    const newItem = { ...(item || {}) };
    if (!newItem.id) {
      let i = 0;
      while (true) {
        const candidate = formatTimestampId(new Date(Date.now() + i * 1000));
        const found = store[key].find((x) => String(x.id) === String(candidate));
        if (!found) {
          newItem.id = candidate;
          break;
        }
        i += 1;
      }
    }
    store[key].push(newItem);
    isDirty = true;
    window.dispatchEvent(new CustomEvent("data-changed"));
    return newItem;
  }

  async function updateItem(key, id, changes) {
    if (!COLLECTIONS[key]) throw new Error("Unknown collection " + key);
    if (!store[key]) {
      throw new Error("Collection not loaded");
    }
    if (Array.isArray(store[key])) {
      const i = store[key].findIndex((x) => String(x.id) === String(id));
      if (i !== -1) {
        store[key][i] = { ...store[key][i], ...changes };
        isDirty = true;
        window.dispatchEvent(new CustomEvent("data-changed"));
        return store[key][i];
      }
      throw new Error("Item not found");
    } else {
      store[key] = { ...store[key], ...changes };
      isDirty = true;
      window.dispatchEvent(new CustomEvent("data-changed"));
      return store[key];
    }
  }

  async function removeItem(key, id) {
    if (!COLLECTIONS[key]) throw new Error("Unknown collection " + key);
    if (!store[key]) {
      throw new Error("Collection not loaded");
    }
    if (!Array.isArray(store[key])) {
      throw new Error("Collection is not an array");
    }
    const initialLength = store[key].length;
    store[key] = store[key].filter((x) => String(x.id) !== String(id));
    if (store[key].length < initialLength) {
      isDirty = true;
      window.dispatchEvent(new CustomEvent("data-changed"));
      return { ok: true };
    }
    throw new Error("Item not found");
  }

  function getMetaDate() {
    const meta = store.meta || null;
    if (!meta || !meta.wedding_date) return null;
    return new Date(meta.wedding_date);
  }

  function isDirtyFlag() {
    return isDirty;
  }

  window.GitHubDataStore = {
    getConfig,
    setConfig,
    clearConfig,
    loadAll,
    loadCollection,
    get,
    addItem,
    updateItem,
    removeItem,
    saveAll,
    saveCollection,
    getMetaDate,
    isDirtyFlag,
  };
})(window);

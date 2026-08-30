(() => {
  "use strict";

  const config = window.APP_CONFIG || {};
  const isConfigured = Boolean(
    config.supabaseUrl &&
    config.supabaseAnonKey &&
    !config.supabaseUrl.includes("YOUR_") &&
    !config.supabaseAnonKey.includes("YOUR_")
  );
  const db = isConfigured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;
  const completionTarget = Number(config.completionPercent) || 90;

  const state = {
    videos: [],
    selectedVideo: null,
    sessionId: null,
    clientToken: null,
    ranges: [],
    activeSeconds: 0,
    maxPosition: 0,
    maxRate: 1,
    seekCount: 0,
    pauseCount: 0,
    lastMediaTime: null,
    lastTick: performance.now(),
    isSeeking: false,
    isSaving: false,
    dirty: false,
    completed: false,
    saveTimer: null,
    tickTimer: null
  };

  const el = (id) => document.getElementById(id);
  const views = {
    catalog: el("catalog-view"),
    identity: el("identity-view"),
    player: el("player-view")
  };
  const player = el("lesson-player");

  document.querySelectorAll("[data-site-name]").forEach((node) => {
    node.textContent = config.siteName || "ВидеоКласс";
  });
  el("current-year").textContent = new Date().getFullYear();

  function showView(name) {
    Object.entries(views).forEach(([key, node]) => node.classList.toggle("hidden", key !== name));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showToast(message, timeout = 3200) {
    const toast = el("toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    window.setTimeout(() => toast.classList.add("hidden"), timeout);
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[character]);
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(new Date(value));
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0 мин";
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return minutes > 0 ? `${minutes} мин ${remainder.toString().padStart(2, "0")} сек` : `${remainder} сек`;
  }

  function normalizeName(value) {
    return value.trim().replace(/\s+/g, " ");
  }

  async function loadVideos() {
    if (!isConfigured) {
      el("setup-warning").classList.remove("hidden");
      el("catalog-loading").classList.add("hidden");
      el("empty-state").classList.remove("hidden");
      el("empty-state").querySelector("h2").textContent = "Сайт готов к подключению";
      el("empty-state").querySelector("p").textContent = "После настройки базы учитель сможет загружать сюда видео.";
      return;
    }

    const { data, error } = await db
      .from("videos")
      .select("id,title,description,storage_path,created_at")
      .eq("published", true)
      .order("created_at", { ascending: false });

    el("catalog-loading").classList.add("hidden");
    if (error) {
      el("empty-state").classList.remove("hidden");
      el("empty-state").querySelector("h2").textContent = "Не удалось загрузить видео";
      el("empty-state").querySelector("p").textContent = "Обновите страницу или сообщите учителю.";
      return;
    }

    state.videos = data || [];
    renderCatalog();
    const requestedId = new URLSearchParams(location.search).get("video");
    if (requestedId) {
      const requested = state.videos.find((video) => video.id === requestedId);
      if (requested) selectVideo(requested);
      else showToast("Это видео не найдено или ещё не опубликовано.");
    }
  }

  function renderCatalog() {
    const grid = el("video-grid");
    if (!state.videos.length) {
      el("empty-state").classList.remove("hidden");
      grid.innerHTML = "";
      return;
    }
    el("empty-state").classList.add("hidden");
    grid.innerHTML = state.videos.map((video) => `
      <article class="video-card">
        <div class="video-thumb"><span class="video-thumb-play" aria-hidden="true">▶</span></div>
        <div class="video-card-body">
          <h2>${escapeHtml(video.title)}</h2>
          <p class="video-description">${escapeHtml(video.description || "Учебный видеоматериал")}</p>
          <div class="video-card-meta">
            <span class="date-chip">${formatDate(video.created_at)}</span>
            <button class="button button-primary button-small" type="button" data-video-id="${video.id}">Смотреть</button>
          </div>
        </div>
      </article>
    `).join("");

    grid.querySelectorAll("[data-video-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const video = state.videos.find((item) => item.id === button.dataset.videoId);
        if (video) selectVideo(video);
      });
    });
  }

  function selectVideo(video) {
    state.selectedVideo = video;
    el("identity-video-title").textContent = video.title;
    el("identity-video-description").textContent = video.description || "";
    const nextUrl = new URL(location.href);
    nextUrl.searchParams.set("video", video.id);
    history.replaceState({}, "", nextUrl);
    showView("identity");
    el("student-name").focus();
  }

  function returnToCatalog() {
    const nextUrl = new URL(location.href);
    nextUrl.searchParams.delete("video");
    history.replaceState({}, "", nextUrl);
    state.selectedVideo = null;
    showView("catalog");
  }

  async function beginWatch(studentName, studentClass) {
    const button = el("identity-form").querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = "Подготавливаем видео…";
    state.clientToken = crypto.randomUUID();

    try {
      const { data: sessionId, error: sessionError } = await db.rpc("start_watch", {
        p_video_id: state.selectedVideo.id,
        p_student_name: studentName,
        p_student_class: studentClass,
        p_client_token: state.clientToken
      });
      if (sessionError) throw sessionError;
      state.sessionId = sessionId;

      const { data: signed, error: signedError } = await db.storage
        .from(config.storageBucket || "lesson-videos")
        .createSignedUrl(state.selectedVideo.storage_path, 60 * 60 * 4);
      if (signedError) throw signedError;

      player.src = signed.signedUrl;
      el("viewer-name").textContent = `${studentName}, ${studentClass}`;
      el("player-title").textContent = state.selectedVideo.title;
      showView("player");
      startTracking();
    } catch (error) {
      console.error(error);
      showToast("Не удалось начать просмотр. Обновите страницу или сообщите учителю.", 5000);
    } finally {
      button.disabled = false;
      button.textContent = "Перейти к просмотру";
    }
  }

  function addRange(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const duration = Number.isFinite(player.duration) ? player.duration : end;
    const next = [Math.max(0, Math.min(start, duration)), Math.max(0, Math.min(end, duration))];
    const sorted = [...state.ranges, next].sort((a, b) => a[0] - b[0]);
    const merged = [];
    sorted.forEach((range) => {
      const previous = merged[merged.length - 1];
      if (!previous || range[0] > previous[1] + 0.5) merged.push([...range]);
      else previous[1] = Math.max(previous[1], range[1]);
    });
    state.ranges = merged;
  }

  function coverageSeconds() {
    return state.ranges.reduce((sum, range) => sum + Math.max(0, range[1] - range[0]), 0);
  }

  function percentWatched() {
    if (!Number.isFinite(player.duration) || player.duration <= 0) return 0;
    return Math.min(100, (coverageSeconds() / player.duration) * 100);
  }

  function currentStatus() {
    const percent = percentWatched();
    const coverage = coverageSeconds();
    if (percent >= completionTarget) return "completed";
    if (state.maxRate > 1.25 || (coverage > 30 && state.activeSeconds / coverage < 0.78)) return "fast";
    if (percent >= 10) return "partial";
    return "started";
  }

  function updateProgressUI() {
    const percent = percentWatched();
    el("progress-text").textContent = `${Math.round(percent)}%`;
    el("progress-bar").style.width = `${percent}%`;
    el("watched-time").textContent = formatDuration(state.activeSeconds);
    if (percent >= completionTarget && !state.completed) {
      state.completed = true;
      el("completed-card").classList.remove("hidden");
      el("completion-hint").textContent = "Требуемый объём просмотра выполнен";
      saveProgress(true);
    }
  }

  function setSaveState(kind, text) {
    const badge = el("save-state");
    badge.classList.remove("saving", "error");
    if (kind) badge.classList.add(kind);
    badge.textContent = text;
  }

  async function saveProgress(force = false) {
    if (!state.sessionId || state.isSaving || (!state.dirty && !force)) return;
    state.isSaving = true;
    setSaveState("saving", "Сохраняем…");
    const payload = {
      p_session_id: state.sessionId,
      p_client_token: state.clientToken,
      p_duration_seconds: Number.isFinite(player.duration) ? Math.round(player.duration * 10) / 10 : 0,
      p_active_seconds: Math.round(state.activeSeconds * 10) / 10,
      p_coverage_seconds: Math.round(coverageSeconds() * 10) / 10,
      p_max_position: Math.round(state.maxPosition * 10) / 10,
      p_percent: Math.round(percentWatched() * 10) / 10,
      p_max_rate: state.maxRate,
      p_seek_count: state.seekCount,
      p_pause_count: state.pauseCount,
      p_status: currentStatus(),
      p_watched_ranges: state.ranges.map(([start, end]) => [Math.round(start * 10) / 10, Math.round(end * 10) / 10])
    };
    state.dirty = false;
    try {
      const { error } = await db.rpc("update_watch", payload);
      if (error) throw error;
      setSaveState("", "Прогресс сохранён");
    } catch (error) {
      console.error(error);
      state.dirty = true;
      setSaveState("error", "Не удалось сохранить");
    } finally {
      state.isSaving = false;
    }
  }

  function startTracking() {
    if (state.tickTimer) return;
    state.lastTick = performance.now();
    state.tickTimer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = Math.min(1.5, (now - state.lastTick) / 1000);
      state.lastTick = now;
      if (!player.paused && !player.ended && !document.hidden) {
        state.activeSeconds += elapsed;
        state.maxPosition = Math.max(state.maxPosition, player.currentTime || 0);
        state.dirty = true;
        updateProgressUI();
      }
    }, 1000);
    state.saveTimer = window.setInterval(() => saveProgress(false), 10000);
  }

  player.addEventListener("timeupdate", () => {
    const current = player.currentTime;
    if (!player.paused && !state.isSeeking && state.lastMediaTime !== null) {
      const delta = current - state.lastMediaTime;
      if (delta > 0 && delta <= Math.max(2.5, player.playbackRate * 2.5)) addRange(state.lastMediaTime, current);
    }
    state.lastMediaTime = current;
    state.maxPosition = Math.max(state.maxPosition, current);
    state.dirty = true;
    updateProgressUI();
  });
  player.addEventListener("seeking", () => { state.isSeeking = true; state.seekCount += 1; state.dirty = true; });
  player.addEventListener("seeked", () => { state.isSeeking = false; state.lastMediaTime = player.currentTime; });
  player.addEventListener("pause", () => { if (!player.ended && player.currentTime > 0) state.pauseCount += 1; state.dirty = true; saveProgress(false); });
  player.addEventListener("ratechange", () => { state.maxRate = Math.max(state.maxRate, player.playbackRate); state.dirty = true; });
  player.addEventListener("ended", () => { state.dirty = true; updateProgressUI(); saveProgress(true); });
  player.addEventListener("error", () => showToast("Видео не загрузилось. Проверьте интернет или сообщите учителю.", 5000));

  document.addEventListener("visibilitychange", () => {
    state.lastTick = performance.now();
    if (document.hidden) saveProgress(true);
  });
  window.addEventListener("pagehide", () => saveProgress(true));

  el("identity-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isConfigured || !state.selectedVideo) return;
    const studentName = normalizeName(el("student-name").value);
    const studentClass = normalizeName(el("student-class").value).toUpperCase();
    if (studentName.length < 3 || studentClass.length < 1) {
      showToast("Проверьте фамилию, имя и класс.");
      return;
    }
    beginWatch(studentName, studentClass);
  });
  document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", returnToCatalog));

  loadVideos();
})();

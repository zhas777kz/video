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
  const state = { user: null, videos: [], sessions: [], selectedVideoId: null, refreshTimer: null };
  const el = (id) => document.getElementById(id);

  document.querySelectorAll("[data-site-name]").forEach((node) => {
    node.textContent = config.siteName || "ВидеоКласс";
  });

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

  function formatDate(value, includeTime = false) {
    if (!value) return "—";
    const options = includeTime
      ? { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }
      : { day: "2-digit", month: "2-digit", year: "numeric" };
    return new Intl.DateTimeFormat("ru-RU", options).format(new Date(value));
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return "0 сек";
    const total = Math.round(Number(seconds));
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return minutes ? `${minutes} мин ${remainder.toString().padStart(2, "0")} сек` : `${remainder} сек`;
  }

  function statusMeta(status) {
    return ({
      completed: ["Досмотрел(а)", "result-completed"],
      partial: ["Частично", "result-partial"],
      fast: ["Быстро", "result-fast"],
      started: ["Начал(а)", "result-started"]
    })[status] || ["Начал(а)", "result-started"];
  }

  function showLogin(message = "") {
    el("login-view").classList.remove("hidden");
    el("dashboard-view").classList.add("hidden");
    el("admin-header-actions").classList.add("hidden");
    if (message) {
      el("login-error").textContent = message;
      el("login-error").classList.remove("hidden");
    }
  }

  async function verifyTeacher(user) {
    const { data, error } = await db.from("teachers").select("user_id").eq("user_id", user.id).maybeSingle();
    return !error && Boolean(data);
  }

  async function enterDashboard(user) {
    const allowed = await verifyTeacher(user);
    if (!allowed) {
      await db.auth.signOut();
      showLogin("У этого аккаунта нет доступа к кабинету учителя.");
      return;
    }
    state.user = user;
    el("teacher-email").textContent = user.email || "Учитель";
    el("login-view").classList.add("hidden");
    el("dashboard-view").classList.remove("hidden");
    el("admin-header-actions").classList.remove("hidden");
    await loadDashboard();
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = window.setInterval(() => loadDashboard(true), 30000);
  }

  async function loadDashboard(silent = false) {
    const [videosResult, sessionsResult] = await Promise.all([
      db.from("videos").select("id,title,description,storage_path,duration_seconds,published,created_at").order("created_at", { ascending: false }),
      db.from("watch_sessions").select("id,video_id,student_name,student_class,started_at,last_seen_at,completed_at,duration_seconds,active_seconds,coverage_seconds,percent,max_rate,seek_count,pause_count,status").order("last_seen_at", { ascending: false })
    ]);
    if (videosResult.error || sessionsResult.error) {
      console.error(videosResult.error || sessionsResult.error);
      if (!silent) showToast("Не удалось загрузить статистику.");
      return;
    }
    state.videos = videosResult.data || [];
    state.sessions = sessionsResult.data || [];
    if (state.selectedVideoId && !state.videos.some((video) => video.id === state.selectedVideoId)) state.selectedVideoId = null;
    renderStats();
    renderVideos();
    if (state.selectedVideoId) renderResults();
  }

  function renderStats() {
    const uniqueStudents = new Set(state.sessions.map((row) => `${row.student_name.toLowerCase()}|${row.student_class.toLowerCase()}`));
    const completed = state.sessions.filter((row) => row.status === "completed").length;
    const average = state.sessions.length
      ? Math.round(state.sessions.reduce((sum, row) => sum + Number(row.percent || 0), 0) / state.sessions.length)
      : 0;
    el("stat-videos").textContent = state.videos.length;
    el("stat-students").textContent = uniqueStudents.size;
    el("stat-completed").textContent = completed;
    el("stat-average").textContent = `${average}%`;
  }

  function renderVideos() {
    const list = el("admin-video-list");
    el("admin-video-empty").classList.toggle("hidden", state.videos.length > 0);
    list.innerHTML = state.videos.map((video) => {
      const count = state.sessions.filter((session) => session.video_id === video.id).length;
      const activeClass = video.id === state.selectedVideoId ? " active" : "";
      return `
        <div class="admin-video-item${activeClass}" role="button" tabindex="0" data-select-video="${video.id}">
          <span class="admin-video-icon" aria-hidden="true">▶</span>
          <span class="admin-video-copy">
            <strong>${escapeHtml(video.title)}</strong>
            <span>${count} ${pluralize(count, "результат", "результата", "результатов")} · ${formatDate(video.created_at)}</span>
          </span>
          <button class="status-pill${video.published ? "" : " draft"}" type="button" data-toggle-video="${video.id}" title="Изменить публикацию">${video.published ? "Опубликовано" : "Черновик"}</button>
        </div>`;
    }).join("");

    list.querySelectorAll("[data-select-video]").forEach((item) => {
      const select = () => selectVideo(item.dataset.selectVideo);
      item.addEventListener("click", (event) => { if (!event.target.closest("[data-toggle-video]")) select(); });
      item.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && !event.target.closest("[data-toggle-video]")) select(); });
    });
    list.querySelectorAll("[data-toggle-video]").forEach((button) => {
      button.addEventListener("click", () => togglePublished(button.dataset.toggleVideo));
    });
  }

  function pluralize(number, one, few, many) {
    const n10 = number % 10;
    const n100 = number % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    return many;
  }

  async function togglePublished(videoId) {
    const video = state.videos.find((item) => item.id === videoId);
    if (!video) return;
    const { error } = await db.from("videos").update({ published: !video.published }).eq("id", videoId);
    if (error) {
      showToast("Не удалось изменить публикацию.");
      return;
    }
    video.published = !video.published;
    renderVideos();
    showToast(video.published ? "Видео опубликовано." : "Видео скрыто от учеников.");
  }

  function selectVideo(videoId) {
    state.selectedVideoId = videoId;
    const video = state.videos.find((item) => item.id === videoId);
    el("results-title").textContent = video?.title || "Результаты";
    el("results-panel").classList.remove("hidden");
    el("result-search").value = "";
    el("status-filter").value = "all";
    renderVideos();
    renderResults();
    el("results-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function filteredSessions() {
    const query = el("result-search").value.trim().toLowerCase();
    const status = el("status-filter").value;
    return state.sessions.filter((row) => {
      if (row.video_id !== state.selectedVideoId) return false;
      if (status !== "all" && row.status !== status) return false;
      if (query && !`${row.student_name} ${row.student_class}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }

  function renderResults() {
    const rows = filteredSessions();
    el("results-empty").classList.toggle("hidden", rows.length > 0);
    el("results-body").innerHTML = rows.map((row) => {
      const [label, className] = statusMeta(row.status);
      const percent = Math.max(0, Math.min(100, Math.round(Number(row.percent) || 0)));
      const rate = Math.max(1, Number(row.max_rate) || 1);
      return `
        <tr>
          <td class="student-cell"><strong>${escapeHtml(row.student_name)}</strong><span>Начал(а): ${formatDate(row.started_at, true)}</span></td>
          <td><strong>${escapeHtml(row.student_class)}</strong></td>
          <td><span class="result-pill ${className}">${label}</span></td>
          <td><div class="mini-progress"><span class="mini-progress-track"><span style="width:${percent}%"></span></span><strong>${percent}%</strong></div></td>
          <td>${formatDuration(row.active_seconds)}</td>
          <td>${rate.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}×</td>
          <td>${Number(row.seek_count) || 0}</td>
          <td>${formatDate(row.last_seen_at, true)}</td>
        </tr>`;
    }).join("");
  }

  function getVideoDuration(file) {
    return new Promise((resolve) => {
      const video = document.createElement("video");
      const objectUrl = URL.createObjectURL(file);
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        const duration = Number.isFinite(video.duration) ? video.duration : null;
        URL.revokeObjectURL(objectUrl);
        resolve(duration);
      };
      video.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(null); };
      video.src = objectUrl;
    });
  }

  function safeFileName(name) {
    const extension = name.includes(".") ? `.${name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "")}` : ".mp4";
    return `${crypto.randomUUID()}${extension}`;
  }

  function setUploadProgress(percent, text) {
    el("upload-progress-wrap").classList.remove("hidden");
    el("upload-progress").style.width = `${percent}%`;
    el("upload-percent").textContent = `${percent}%`;
    el("upload-status").textContent = text;
  }

  async function resumableUpload(path, file) {
    if (!window.tus?.Upload) throw new Error("Модуль надёжной загрузки не открылся. Обновите страницу.");
    const { data } = await db.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error("Сеанс учителя завершён. Войдите снова.");

    const serviceUrl = new URL(config.supabaseUrl);
    const projectId = serviceUrl.hostname.endsWith(".supabase.co") ? serviceUrl.hostname.split(".")[0] : null;
    const uploadHost = projectId ? `${projectId}.storage.supabase.co` : serviceUrl.hostname;
    const endpoint = `${serviceUrl.protocol}//${uploadHost}/storage/v1/upload/resumable`;

    return new Promise((resolve, reject) => {
      const upload = new window.tus.Upload(file, {
        endpoint,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        headers: { authorization: `Bearer ${accessToken}` },
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        metadata: {
          bucketName: config.storageBucket || "lesson-videos",
          objectName: path,
          contentType: file.type || "video/mp4",
          cacheControl: "3600"
        },
        chunkSize: 6 * 1024 * 1024,
        onError: reject,
        onProgress: (uploaded, total) => {
          const percent = total ? Math.max(5, Math.min(94, Math.round((uploaded / total) * 90) + 5)) : 5;
          setUploadProgress(percent, "Загружаем файл…");
        },
        onSuccess: resolve
      });
      upload.findPreviousUploads().then((previous) => {
        if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      }).catch(reject);
    });
  }

  async function uploadVideo() {
    const file = el("video-file").files[0];
    const title = el("video-title").value.trim();
    const description = el("video-description").value.trim();
    const published = el("video-published").checked;
    const errorNode = el("upload-error");
    const submit = el("submit-upload");
    errorNode.classList.add("hidden");

    if (!file || !title) return;
    if (!file.type.startsWith("video/")) {
      errorNode.textContent = "Выберите видеофайл MP4, WebM или MOV.";
      errorNode.classList.remove("hidden");
      return;
    }

    submit.disabled = true;
    el("cancel-upload").disabled = true;
    el("close-upload").disabled = true;
    const path = `${state.user.id}/${safeFileName(file.name)}`;
    try {
      setUploadProgress(10, "Проверяем видео…");
      const duration = await getVideoDuration(file);
      setUploadProgress(15, "Загружаем файл…");
      await resumableUpload(path, file);

      setUploadProgress(96, "Сохраняем материал…");
      const { error: rowError } = await db.from("videos").insert({
        title,
        description: description || null,
        storage_path: path,
        duration_seconds: duration,
        published,
        created_by: state.user.id
      });
      if (rowError) {
        await db.storage.from(config.storageBucket || "lesson-videos").remove([path]);
        throw rowError;
      }
      setUploadProgress(100, "Готово");
      await loadDashboard();
      window.setTimeout(() => {
        el("upload-dialog").close();
        resetUploadForm();
      }, 450);
      showToast("Видео загружено.");
    } catch (error) {
      console.error(error);
      errorNode.textContent = error?.message?.includes("maximum allowed size")
        ? "Файл больше разрешённого размера хранилища. Уменьшите видео или измените лимит."
        : `Не удалось загрузить видео: ${error?.message || "неизвестная ошибка"}`;
      errorNode.classList.remove("hidden");
    } finally {
      submit.disabled = false;
      el("cancel-upload").disabled = false;
      el("close-upload").disabled = false;
    }
  }

  function resetUploadForm() {
    el("upload-form").reset();
    el("video-published").checked = true;
    el("file-label").textContent = "Выберите MP4, WebM или MOV";
    el("upload-progress-wrap").classList.add("hidden");
    el("upload-progress").style.width = "0";
    el("upload-error").classList.add("hidden");
  }

  function copyVideoLink() {
    if (!state.selectedVideoId) return;
    const url = new URL("./", location.href);
    url.searchParams.set("video", state.selectedVideoId);
    navigator.clipboard.writeText(url.href)
      .then(() => showToast("Ссылка скопирована."))
      .catch(() => showToast(`Скопируйте ссылку: ${url.href}`, 7000));
  }

  function csvCell(value) {
    const text = String(value ?? "").replace(/"/g, '""');
    return `"${text}"`;
  }

  function exportCsv() {
    const rows = filteredSessions();
    const headers = ["Фамилия и имя", "Класс", "Результат", "Просмотрено, %", "Время просмотра, сек", "Максимальная скорость", "Перемотки", "Паузы", "Начало", "Последняя активность"];
    const body = rows.map((row) => {
      const [status] = statusMeta(row.status);
      return [row.student_name, row.student_class, status, row.percent, row.active_seconds, row.max_rate, row.seek_count, row.pause_count, formatDate(row.started_at, true), formatDate(row.last_seen_at, true)];
    });
    const csv = "\ufeff" + [headers, ...body].map((row) => row.map(csvCell).join(";")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const video = state.videos.find((item) => item.id === state.selectedVideoId);
    link.href = url;
    link.download = `Результаты_${(video?.title || "видео").replace(/[^a-zа-яё0-9_-]+/gi, "_")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  el("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    el("login-error").classList.add("hidden");
    button.disabled = true;
    button.textContent = "Входим…";
    const { data, error } = await db.auth.signInWithPassword({ email: el("email").value.trim(), password: el("password").value });
    button.disabled = false;
    button.textContent = "Войти";
    if (error) {
      el("login-error").textContent = "Неверная почта или пароль.";
      el("login-error").classList.remove("hidden");
      return;
    }
    await enterDashboard(data.user);
  });
  el("sign-out").addEventListener("click", async () => { await db.auth.signOut(); state.user = null; window.clearInterval(state.refreshTimer); showLogin(); });
  el("open-upload").addEventListener("click", () => el("upload-dialog").showModal());
  el("close-upload").addEventListener("click", () => { el("upload-dialog").close(); resetUploadForm(); });
  el("cancel-upload").addEventListener("click", () => { el("upload-dialog").close(); resetUploadForm(); });
  el("upload-form").addEventListener("submit", (event) => { event.preventDefault(); uploadVideo(); });
  el("video-file").addEventListener("change", () => {
    const file = el("video-file").files[0];
    el("file-label").textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} МБ` : "Выберите MP4, WebM или MOV";
  });
  el("result-search").addEventListener("input", renderResults);
  el("status-filter").addEventListener("change", renderResults);
  el("copy-link").addEventListener("click", copyVideoLink);
  el("export-csv").addEventListener("click", exportCsv);

  async function init() {
    if (!isConfigured) {
      el("setup-warning").classList.remove("hidden");
      el("login-form").querySelector("button[type=submit]").disabled = true;
      return;
    }
    const { data } = await db.auth.getSession();
    if (data.session?.user) await enterDashboard(data.session.user);
    else showLogin();
  }

  init();
})();

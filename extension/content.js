// Content script injected into YouTube pages to capture current Video ID, Title, and HTML5 <video> stall/seek events

(function () {
  let currentVideoId = null;
  let attachedVideoEl = null;
  let stallStartMs = null;

  function getVideoIdFromLocation() {
    try {
      const u = new URL(window.location.href);
      if (u.pathname === "/watch") {
        return u.searchParams.get("v");
      }
      const shortsMatch = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
      if (shortsMatch) return shortsMatch[1];
    } catch (_) {}
    return null;
  }

  function getCleanTitle() {
    return (document.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "").trim();
  }

  function syncVideoMeta() {
    const vid = getVideoIdFromLocation();
    const title = getCleanTitle();
    if (vid) {
      currentVideoId = vid;
      chrome.runtime.sendMessage({
        type: "YT_VIDEO_META",
        videoId: vid,
        title,
        url: window.location.href
      }).catch(() => {});
    }
  }

  function sendPlayerEvent(eventType, extra = {}) {
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    let bufferedAheadSec = null;
    let currentTimeSec = null;
    if (video) {
      currentTimeSec = Number(video.currentTime.toFixed(2));
      const buf = video.buffered;
      for (let i = 0; i < buf.length; i++) {
        if (buf.start(i) <= video.currentTime && buf.end(i) >= video.currentTime) {
          bufferedAheadSec = Number((buf.end(i) - video.currentTime).toFixed(2));
          break;
        }
      }
    }

    chrome.runtime.sendMessage({
      type: "YT_PLAYER_EVENT",
      payload: {
        eventType,
        videoId: getVideoIdFromLocation() || currentVideoId,
        videoTitle: getCleanTitle(),
        currentTimeSec,
        bufferedAheadSec,
        ...extra
      }
    }).catch(() => {});
  }

  function attachToVideoElement() {
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!video || video === attachedVideoEl) return;
    attachedVideoEl = video;

    video.addEventListener("waiting", () => {
      stallStartMs = performance.now();
      sendPlayerEvent("BUFFER_WAITING_START");
    });

    video.addEventListener("playing", () => {
      let stallDurationMs = null;
      if (stallStartMs !== null) {
        stallDurationMs = Math.round(performance.now() - stallStartMs);
        stallStartMs = null;
      }
      sendPlayerEvent("PLAYING_RESUMED", { stallDurationMs });
    });

    video.addEventListener("seeking", () => {
      stallStartMs = performance.now();
      sendPlayerEvent("USER_SEEKING");
    });

    video.addEventListener("seeked", () => {
      let seekLatencyMs = null;
      if (stallStartMs !== null) {
        seekLatencyMs = Math.round(performance.now() - stallStartMs);
        stallStartMs = null;
      }
      sendPlayerEvent("USER_SEEKED_READY", { seekLatencyMs });
    });

    video.addEventListener("stalled", () => {
      sendPlayerEvent("NETWORK_STALLED_EVENT");
    });

    video.addEventListener("error", () => {
      sendPlayerEvent("VIDEO_ELEMENT_ERROR", {
        mediaErrorCode: video.error ? video.error.code : null,
        mediaErrorMessage: video.error ? video.error.message : null
      });
    });
  }

  // Observe SPA navigation on YouTube
  window.addEventListener("yt-navigate-finish", () => {
    setTimeout(() => {
      syncVideoMeta();
      attachToVideoElement();
    }, 300);
  });

  setInterval(() => {
    syncVideoMeta();
    attachToVideoElement();
  }, 2000);

  syncVideoMeta();
  attachToVideoElement();
})();

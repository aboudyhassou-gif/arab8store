/* ARAB STORE Web Push service worker — يعمل حتى والموقع مغلق تماماً */
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || "ARAB STORE";
  const options = {
    body: data.message || "لديك تحديث جديد في المتجر",
    icon: data.icon || "/site-icon",
    badge: "/site-icon",
    tag: "arab-store-" + (data.title || "notification"),
    renotify: true,
    vibrate: [120, 60, 120],
    data: { url: data.url || "/store.html" },
  };
  if (data.image) options.image = data.image;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/activity.html";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return clients.openWindow(target);
    })
  );
});

export function createKeepAwakeController(blocker) {
  let id = null;
  let companion = false;
  let phone = false;
  let onBattery = true;
  let server = null;
  let stopped = false;

  function sync() {
    const shouldBlock = !stopped && (companion || (phone && !onBattery));
    if (shouldBlock && id === null) {
      id = blocker.start("prevent-app-suspension");
    } else if (!shouldBlock && id !== null) {
      if (blocker.isStarted(id)) blocker.stop(id);
      id = null;
    }
  }

  return {
    setCompanion(enabled, keepAwake) {
      companion = enabled && keepAwake;
      sync();
    },
    setOnBattery(value) {
      onBattery = value;
      sync();
    },
    setPhoneServer(child) {
      if (stopped) return;
      server = child;
      phone = false;
      sync();
      child.on("message", (message) => {
        if (server !== child || message?.type !== "wink:phone-keep-awake") return;
        if (message.on !== true && message.on !== false) return;
        phone = message.on;
        sync();
      });
      child.once("exit", () => {
        if (server !== child) return;
        server = null;
        phone = false;
        sync();
      });
    },
    stop() {
      stopped = true;
      server = null;
      sync();
    },
  };
}

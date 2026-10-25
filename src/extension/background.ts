import { preseedDnrRules } from "./background/dnr-rules";
import { registerBackgroundNotifications } from "./background/notifications";
import { registerContentScriptReinjection } from "./background/reinject";
import { registerBackgroundStorageBridge } from "./background/storage-bridge";
import { registerBackgroundTelemetryConsent } from "./background/telemetry-guard";
import { registerXhrPortListener } from "./background/xhr-handler";

registerBackgroundStorageBridge();
registerBackgroundTelemetryConsent();
registerBackgroundNotifications();
registerXhrPortListener();
registerContentScriptReinjection();
preseedDnrRules();

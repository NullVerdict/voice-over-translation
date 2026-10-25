// CRXJS inlines this entry into a synchronous document_start IIFE so GM
// globals exist before MAIN-world scripts run. The handshake stays async.
import { bootstrapExtensionPrelude } from "./prelude/index";

bootstrapExtensionPrelude();

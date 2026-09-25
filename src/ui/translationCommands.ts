import { openAuthWindow } from "../core/auth/window";
import { t } from "../localization/localizationProvider";
import { deleteExpiredAccount } from "../stores/account";
import type { Status } from "../types/components/votButton";
import debug from "../utils/debug";
import { isAbortError } from "../utils/errors";
import type { VideoHandler } from "../VideoHandler";
import VOTLocalizedError from "../VOTLocalizedError";

type TranslationButtonCommandDeps = {
  videoHandler?: VideoHandler;
  currentStatus: Status;
  currentLoading: boolean;
  transformBtn(status: Status, text: string): void;
};

async function getVideoDataForTranslation(videoHandler: VideoHandler) {
  if (!videoHandler.videoData?.videoId) {
    throw new VOTLocalizedError("VOTNoVideoIDFound");
  }

  if (shouldRefreshVideoDataBeforeTranslation(videoHandler)) {
    videoHandler.videoData = await videoHandler.getVideoData();
  }

  if (!videoHandler.videoData?.videoId) {
    throw new VOTLocalizedError("VOTNoVideoIDFound");
  }

  return videoHandler.videoData;
}

function shouldRefreshVideoDataBeforeTranslation(videoHandler: VideoHandler) {
  return (
    (videoHandler.site.host === "vk" &&
      videoHandler.site.additionalData === "clips") ||
    videoHandler.site.host === "douyin"
  );
}

async function prepareAuthStateForTranslation(
  videoHandler: VideoHandler,
): Promise<void> {
  // Missing account and expired session are different states. Live voices may be
  // requested without an account, but an expired saved session should be shown to
  // the user explicitly instead of falling through to a generic login-required
  // backend response.
  const expired = await deleteExpiredAccount(videoHandler);
  if (!expired) {
    return;
  }

  await openAuthWindow();
  throw new VOTLocalizedError("VOTYandexTokenExpired");
}

function resetAutoLanguageOverride(
  videoHandler: VideoHandler,
  videoId: string,
  responseLanguage: string,
): void {
  if (
    !videoHandler.autoSourceLanguageOverrideVideoId ||
    videoHandler.autoSourceLanguageOverrideVideoId === videoId
  ) {
    return;
  }
  videoHandler.translateFromLang = "auto";
  videoHandler.autoSourceLanguageOverrideVideoId = undefined;
  videoHandler.setSelectMenuValues("auto", responseLanguage);
}

function handleTranslationError(
  deps: TranslationButtonCommandDeps,
  error: unknown,
): void {
  if (isAbortError(error)) {
    deps.transformBtn("none", t("translateVideo"));
    return;
  }
  console.error("[VOT]", error);
  if (!(error instanceof Error)) {
    deps.transformBtn("error", String(error));
    return;
  }
  const message =
    error.name === "VOTLocalizedError"
      ? (error as VOTLocalizedError).localizedMessage
      : error.message;
  deps.transformBtn("error", message);
}

export async function handleTranslationButtonCommand(
  deps: TranslationButtonCommandDeps,
) {
  const videoHandler = deps.videoHandler;
  if (!videoHandler) {
    return;
  }

  debug.log("[handleTranslationBtnClick] click translationBtn");
  if (videoHandler.hasActiveSource()) {
    debug.log("[handleTranslationBtnClick] video has active source");
    await videoHandler.stopTranslation();
    return;
  }

  // A click on an errored, idle button is the retry action: reset the button
  // and fall through to translation in this same click instead of taking the
  // stop/abort branch (which would kill background preparation).
  const isRetry = deps.currentStatus === "error" && !deps.currentLoading;
  if (isRetry) {
    deps.transformBtn("none", t("translateVideo"));
  }

  if (!isRetry && (deps.currentStatus !== "none" || deps.currentLoading)) {
    debug.log("[handleTranslationBtnClick] translationBtn isn't in none state");
    videoHandler.actionsAbortController.abort();
    await videoHandler.stopTranslation();
    return;
  }

  try {
    await prepareAuthStateForTranslation(videoHandler);

    debug.log("[handleTranslationBtnClick] trying execute translation");
    const videoData = await getVideoDataForTranslation(videoHandler);

    // Automatic fallback belongs only to the video where it was selected.
    // Reset it before resolving the language of a newly opened video.
    resetAutoLanguageOverride(
      videoHandler,
      videoData.videoId,
      videoData.responseLanguage,
    );

    await videoHandler.videoManager.ensureDetectedLanguageForTranslation(
      videoData,
    );

    debug.log(
      "[handleTranslationBtnClick] Run translateFunc",
      videoData.videoId,
    );
    const requestLang =
      videoHandler.translateFromLang === "auto"
        ? videoData.detectedLanguage
        : videoHandler.translateFromLang;

    await videoHandler.translateFunc(
      videoData.videoId,
      videoData.isStream,
      requestLang,
      videoData.responseLanguage,
      videoData.translationHelp,
    );
  } catch (err) {
    handleTranslationError(deps, err);
  }
}

import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
  requestUrl
} from "obsidian";

type StrategyId = "five-folder" | "flat-root" | "attachments-only";
type PlanKind = "reorganization" | "image-rename" | "handwriting" | "cleanup";
type ImageRenameDetail = "low" | "auto" | "high";

interface VaultReorganizerSettings {
  strategy: StrategyId;
  markdownFolder: string;
  imagesFolder: string;
  videosFolder: string;
  soundFolder: string;
  attachmentsFolder: string;
  templatesFolder: string;
  canvasesFolder: string;
  basesFolder: string;
  otherFilesFolder: string;
  excludedFolders: string;
  templateFolders: string;
  imageExtensions: string;
  videoExtensions: string;
  soundExtensions: string;
  attachmentExtensions: string;
  openAiApiKey: string;
  imageRenameModel: string;
  imageRenameExtensions: string;
  imageRenameMaxFiles: number;
  imageRenameDetail: ImageRenameDetail;
  handwritingSourceFiles: string;
  handwritingSourceFolder: string;
  handwritingNotesFolder: string;
  handwritingModel: string;
  handwritingExtensions: string;
  handwritingMaxFiles: number;
  handwritingDetail: ImageRenameDetail;
  splitOversizedHandwritingPdfs: boolean;
  handwritingPdfPageLimit: number;
  removeEmptyFolders: boolean;
  removeJunkFilesBeforeFolderCleanup: boolean;
}

interface TargetChoice {
  folder: string;
  category: string;
  reason: string;
}

interface PlannedMove {
  file: TFile;
  source: string;
  target: string;
  category: string;
  reason: string;
}

interface SkippedFile {
  path: string;
  reason: string;
}

interface MoveFailure {
  source: string;
  target: string;
  error: string;
}

interface FolderCleanupFailure {
  path: string;
  error: string;
}

interface RemainingFolder {
  path: string;
  files: number;
  folders: number;
  hiddenPaths: string[];
}

interface FolderCleanupResult {
  removed: number;
  junkRemoved: number;
  skipped: SkippedFile[];
  failed: FolderCleanupFailure[];
  remaining: RemainingFolder[];
  scanned: number;
}

interface FileManagerWithOptionalTrash {
  trashFile?: (file: TAbstractFile) => Promise<void>;
}

interface ApplyResult {
  planKind: PlanKind;
  planLabel: string;
  moved: number;
  directRenamed: number;
  copiedFallback: number;
  skipped: SkippedFile[];
  failed: MoveFailure[];
  cleanupRemoved: number;
  cleanupJunkRemoved: number;
  cleanupScanned: number;
  cleanupSkipped: SkippedFile[];
  cleanupFailed: FolderCleanupFailure[];
  cleanupRemaining: RemainingFolder[];
}

interface ReorganizationPlan {
  kind: "reorganization" | "image-rename";
  label: string;
  moves: PlannedMove[];
  skipped: SkippedFile[];
  warnings: string[];
  strategy: StrategyId;
}

interface PlannedMarkdownNote {
  sourceFile: TFile;
  source: string;
  target: string;
  title: string;
  markdown: string;
  reason: string;
}

interface HandwritingPlan {
  kind: "handwriting";
  label: string;
  notes: PlannedMarkdownNote[];
  skipped: SkippedFile[];
  warnings: string[];
}

interface HandwritingExtraction {
  isHandwrittenNote: boolean;
  title: string;
  markdown: string;
}

interface RenderedPdfPageImage {
  pageNumber: number;
  imageUrl: string;
  width: number;
  height: number;
  bytes: number;
}

interface PdfDocumentForRendering {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageForRendering>;
  destroy(): Promise<void> | void;
}

interface PdfPageForRendering {
  getViewport(params: { scale: number }): PdfViewportForRendering;
  render(params: { canvas: HTMLCanvasElement; viewport: PdfViewportForRendering; background?: string }): {
    promise: Promise<void>;
  };
  cleanup(): void;
}

interface PdfViewportForRendering {
  width: number;
  height: number;
}

type OpenAIHandwritingContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_file"; filename: string; file_data: string }
  | { type: "input_image"; image_url: string; detail: ImageRenameDetail };

interface PdfJsRuntime {
  getDocument(src: Record<string, unknown>): {
    promise: Promise<unknown>;
  };
  VerbosityLevel: {
    ERRORS: number;
  };
  restoreWorkerGlobal(): void;
}

interface PdfJsWorkerGlobal {
  pdfjsWorker?: {
    WorkerMessageHandler?: unknown;
    __vaultReorganizerPdfJs?: boolean;
  };
}

type ActivePlan = ReorganizationPlan | HandwritingPlan;

const STRATEGY_LABELS: Record<StrategyId, string> = {
  "five-folder": "Nine folder vault",
  "flat-root": "Markdown in root",
  "attachments-only": "Centralize attachments only"
};

const DEFAULT_SETTINGS: VaultReorganizerSettings = {
  strategy: "five-folder",
  markdownFolder: "Notes",
  imagesFolder: "Images",
  videosFolder: "Videos",
  soundFolder: "Sound",
  attachmentsFolder: "Attachments",
  templatesFolder: "Templates",
  canvasesFolder: "Canvases",
  basesFolder: "Bases",
  otherFilesFolder: "Files",
  excludedFolders: ".trash,Archive",
  templateFolders: "Templates,Template",
  imageExtensions: "png,jpg,jpeg,gif,webp,svg,avif,bmp,heic",
  videoExtensions: "mp4,mov,webm,mkv,avi,m4v",
  soundExtensions: "mp3,wav,m4a,aac,flac,ogg,opus",
  attachmentExtensions: "pdf,doc,docx,xls,xlsx,ppt,pptx,zip",
  openAiApiKey: "",
  imageRenameModel: "gpt-5.5",
  imageRenameExtensions: "png,jpg,jpeg,webp,gif",
  imageRenameMaxFiles: 25,
  imageRenameDetail: "low",
  handwritingSourceFiles: "",
  handwritingSourceFolder: "Images,Attachments",
  handwritingNotesFolder: "Notes/Handwritten",
  handwritingModel: "gpt-5.5",
  handwritingExtensions: "png,jpg,jpeg,webp,gif,pdf",
  handwritingMaxFiles: 50,
  handwritingDetail: "high",
  splitOversizedHandwritingPdfs: true,
  handwritingPdfPageLimit: 25,
  removeEmptyFolders: false,
  removeJunkFilesBeforeFolderCleanup: false
};

const REPORTS_FOLDER = "Vault Reorganizer Reports";
const MAX_PREVIEW_ROWS = 300;
const MAX_FAILURE_ROWS = 100;
const MAX_IMAGE_RENAME_BYTES = 20 * 1024 * 1024;
const MAX_HANDWRITING_FILE_BYTES = 20 * 1024 * 1024;
const PDF_PAGE_JPEG_START_QUALITY = 0.86;
const PDF_PAGE_JPEG_MIN_QUALITY = 0.52;
const PDF_PAGE_JPEG_QUALITY_STEP = 0.08;
const PDF_PAGE_RENDER_MIN_SCALE = 1.1;
const CLEANUP_JUNK_FILE_NAMES = new Set(["thumbs.db", "desktop.ini"]);
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const IMAGE_RENAME_MIME_TYPES: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};

export default class VaultReorganizerPlugin extends Plugin {
  settings: VaultReorganizerSettings;
  lastPlan: ActivePlan | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "open-vault-reorganization-planner",
      name: "Open vault reorganization planner",
      callback: () => new ReorganizerModal(this.app, this).open()
    });

    this.addCommand({
      id: "preview-vault-reorganization",
      name: "Preview vault reorganization moves",
      callback: () => new ReorganizerModal(this.app, this).open()
    });

    this.addCommand({
      id: "preview-image-subject-renames",
      name: "Preview image subject renames",
      callback: () => new ReorganizerModal(this.app, this).open()
    });

    this.addCommand({
      id: "preview-handwriting-markdown",
      name: "Preview handwritten notes to Markdown",
      callback: () => new ReorganizerModal(this.app, this).open()
    });

    this.addCommand({
      id: "remove-empty-folders",
      name: "Remove empty folders",
      callback: async () => {
        const cleanup = await this.removeEmptyFolders();
        console.info("Vault Reorganizer empty folder cleanup", cleanup);
        new Notice(formatCleanupNotice(cleanup));
      }
    });

    this.addSettingTab(new VaultReorganizerSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    const loadedSettings = (await this.loadData()) as unknown;
    const savedSettings = isRecord(loadedSettings) ? (loadedSettings as Partial<VaultReorganizerSettings>) : {};
    this.settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...savedSettings });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async buildPlan(strategy = this.settings.strategy): Promise<ReorganizationPlan> {
    const moves: PlannedMove[] = [];
    const skipped: SkippedFile[] = [];
    const warnings: string[] = [];
    const proposedTargets = new Set<string>();
    const files = this.app.vault.getFiles();

    for (const file of files) {
      if (this.isExcluded(file.path)) {
        skipped.push({ path: file.path, reason: "Excluded folder" });
        continue;
      }

      const choice = this.chooseTarget(file, strategy);
      if (!choice) {
        skipped.push({ path: file.path, reason: "No move for selected strategy" });
        continue;
      }

      const desiredTarget = joinPath(choice.folder, file.name);
      if (normalizePath(file.path) === desiredTarget) {
        skipped.push({ path: file.path, reason: "Already in target location" });
        continue;
      }

      const target = await this.findAvailablePath(file.path, desiredTarget, proposedTargets);
      proposedTargets.add(target);
      moves.push({
        file,
        source: file.path,
        target,
        category: choice.category,
        reason: choice.reason
      });
    }

    if (moves.length > 0 && !this.settings.removeEmptyFolders) {
      warnings.push("Old empty folders will be left in place. Enable cleanup in settings if you want empty folders removed after moving files.");
    }

    if (moves.length > MAX_PREVIEW_ROWS) {
      warnings.push(`Preview shows the first ${MAX_PREVIEW_ROWS} of ${moves.length} planned moves.`);
    }

    return {
      kind: "reorganization",
      label: STRATEGY_LABELS[strategy],
      moves,
      skipped,
      warnings,
      strategy
    };
  }

  async buildImageRenamePlan(onProgress?: (completed: number, total: number, path: string) => void): Promise<ReorganizationPlan> {
    const apiKey = this.settings.openAiApiKey.trim();
    if (!apiKey) {
      throw new Error("Add your OpenAI API key in Vault Reorganizer settings before generating image subject names.");
    }

    const moves: PlannedMove[] = [];
    const skipped: SkippedFile[] = [];
    const warnings: string[] = [];
    const proposedTargets = new Set<string>();
    const imageFiles = this.app.vault.getFiles().filter((file) => !this.isExcluded(file.path) && this.isImage(file));
    const renameLimit = normalizePositiveInteger(this.settings.imageRenameMaxFiles, DEFAULT_SETTINGS.imageRenameMaxFiles);
    const renameableImages = imageFiles.filter((file) => this.shouldRenameImage(file) && this.canAnalyzeImage(file));
    const totalToAnalyze = Math.min(renameableImages.length, renameLimit);
    let analyzed = 0;
    let imageNamingFailures = 0;

    if (renameableImages.length > renameLimit) {
      warnings.push(
        `Only the first ${renameLimit} generic image filenames will be analyzed with OpenAI in this preview. The remaining images can still be moved to Images.`
      );
    }

    for (const file of imageFiles) {
      const hasReadableName = hasHumanReadableImageName(file);
      const shouldRename = !hasReadableName;
      let targetName = file.name;
      let reason = hasReadableName ? "Human-readable image name; move to Images" : "Generic image filename; move to Images";

      if (shouldRename) {
        if (!this.isImageRenameExtension(file)) {
          reason = "Image type is not supported for AI naming; move to Images only";
        } else if (file.stat.size > MAX_IMAGE_RENAME_BYTES) {
          reason = "Image is over 20 MB; move to Images only";
        } else if (analyzed >= renameLimit) {
          reason = "Image rename scan limit reached; move to Images only";
        } else {
          analyzed += 1;
          onProgress?.(analyzed, totalToAnalyze, file.path);
          try {
            const subject = await this.requestImageSubjectNameWithRetry(file);
            const sanitizedSubject = subject ? sanitizeImageSubjectStem(subject) : "";
            if (sanitizedSubject) {
              targetName = `${sanitizedSubject}.${file.extension.toLowerCase()}`;
              reason = `AI image subject: ${sanitizedSubject.replace(/-/g, " ")}`;
            } else {
              imageNamingFailures += 1;
              reason = "AI returned no usable subject; move to Images only";
            }
          } catch (error) {
            imageNamingFailures += 1;
            reason = `AI naming failed: ${formatImageNamingError(error)}; move to Images only`;
          }
        }
      }

      const desiredTarget = joinPath(this.settings.imagesFolder, targetName);
      if (normalizePath(file.path) === desiredTarget) {
        skipped.push({ path: file.path, reason: "Already in Images with the target name" });
        continue;
      }

      const target = await this.findAvailablePath(file.path, desiredTarget, proposedTargets);
      proposedTargets.add(target);
      moves.push({
        file,
        source: file.path,
        target,
        category: "image",
        reason
      });
    }

    if (moves.length > MAX_PREVIEW_ROWS) {
      warnings.push(`Preview shows the first ${MAX_PREVIEW_ROWS} of ${moves.length} planned image updates.`);
    }

    if (imageNamingFailures > 0) {
      warnings.push(
        `${imageNamingFailures} image name${imageNamingFailures === 1 ? "" : "s"} could not be generated. Those files will still be moved to Images with their current filenames.`
      );
    }

    return {
      kind: "image-rename",
      label: "Image subject rename",
      moves,
      skipped,
      warnings,
      strategy: this.settings.strategy
    };
  }

  async buildHandwritingPlan(onProgress?: (completed: number, total: number, path: string) => void): Promise<HandwritingPlan> {
    const apiKey = this.settings.openAiApiKey.trim();
    if (!apiKey) {
      throw new Error("Add your OpenAI API key in Vault Reorganizer settings before converting handwriting to Markdown.");
    }

    const notes: PlannedMarkdownNote[] = [];
    const skipped: SkippedFile[] = [];
    const warnings: string[] = [];
    const proposedTargets = new Set<string>();
    let splitPdfCount = 0;
    const specifiedFiles = this.resolveHandwritingSourceFiles(skipped);
    const sourceFolders = parseSourceFolders(this.settings.handwritingSourceFolder || DEFAULT_SETTINGS.handwritingSourceFolder);
    const sourceLabel = sourceFolders.length > 0 ? sourceFolders.join(", ") : "the vault";
    const candidateFiles =
      specifiedFiles.length > 0
        ? specifiedFiles
        : this.app.vault
            .getFiles()
            .filter((file) => !this.isExcluded(file.path))
            .filter(
              (file) => sourceFolders.length === 0 || sourceFolders.some((folder) => pathStartsWithFolder(file.path, folder))
            )
            .filter((file) => this.isHandwritingExtension(file));
    const conversionLimit = normalizePositiveInteger(
      this.settings.handwritingMaxFiles,
      DEFAULT_SETTINGS.handwritingMaxFiles
    );
    const filesToAnalyze = specifiedFiles.length > 0 ? candidateFiles : candidateFiles.slice(0, conversionLimit);

    if (specifiedFiles.length === 0 && candidateFiles.length > conversionLimit) {
      warnings.push(
        `Only the first ${conversionLimit} supported files in ${sourceLabel} will be analyzed in this preview.`
      );
    }

    if (specifiedFiles.length > 0) {
      warnings.push(
        `Using ${specifiedFiles.length} specifically listed handwriting source file${specifiedFiles.length === 1 ? "" : "s"} and treating them as handwritten notes.`
      );
    }

    for (let index = 0; index < filesToAnalyze.length; index += 1) {
      const file = filesToAnalyze[index];
      onProgress?.(index + 1, filesToAnalyze.length, file.path);
      const shouldSplitPdf =
        specifiedFiles.length > 0 &&
        file.stat.size > MAX_HANDWRITING_FILE_BYTES &&
        this.shouldSplitOversizedHandwritingPdf(file);

      if (file.stat.size > MAX_HANDWRITING_FILE_BYTES) {
        if (!shouldSplitPdf) {
          skipped.push({
            path: file.path,
            reason: buildOversizedHandwritingFileReason(file, this.canSplitOversizedHandwritingPdf(file))
          });
          continue;
        }
        onProgress?.(index + 1, filesToAnalyze.length, `${file.path} (splitting oversized PDF)`);
      }

      try {
        const extraction = shouldSplitPdf
          ? await this.requestSplitPdfHandwritingMarkdownWithRetry(file, specifiedFiles.length > 0)
          : await this.requestHandwritingMarkdownWithRetry(file, specifiedFiles.length > 0);
        if (!extraction.isHandwrittenNote && specifiedFiles.length === 0) {
          skipped.push({ path: file.path, reason: "AI did not detect a handwritten note" });
          continue;
        }

        const markdown = extraction.markdown.trim();
        if (!markdown) {
          skipped.push({ path: file.path, reason: "AI returned no Markdown text" });
          continue;
        }

        const title = sanitizeMarkdownTitle(extraction.title || fileStem(file.name));
        const desiredTarget = joinPath(getHandwritingNotesFolder(this.settings), `${title}.md`);
        const target = await this.findAvailableNewPath(desiredTarget, proposedTargets);
        if (!this.isSafeHandwritingNoteTarget(target)) {
          skipped.push({ path: file.path, reason: `Generated Markdown note target was unsafe: ${target}` });
          continue;
        }
        proposedTargets.add(target);
        notes.push({
          sourceFile: file,
          source: file.path,
          target,
          title,
          markdown: formatHandwritingNoteMarkdown(title, file.path, markdown, getHandwritingSourceLabel(file)),
          reason: shouldSplitPdf ? "Oversized PDF split into page images" : "Handwritten note detected"
        });
        if (shouldSplitPdf) {
          splitPdfCount += 1;
        }
      } catch (error) {
        skipped.push({ path: file.path, reason: `Handwriting conversion failed: ${formatImageNamingError(error)}` });
      }
    }

    if (notes.length > MAX_PREVIEW_ROWS) {
      warnings.push(`Preview shows the first ${MAX_PREVIEW_ROWS} of ${notes.length} planned Markdown notes.`);
    }

    if (splitPdfCount > 0) {
      warnings.push(
        `${splitPdfCount} oversized PDF${splitPdfCount === 1 ? " was" : "s were"} rendered into temporary page images and combined into one Markdown note per PDF.`
      );
    }

    return {
      kind: "handwriting",
      label: "Handwriting to Markdown",
      notes,
      skipped,
      warnings
    };
  }

  async applyPlan(plan: ReorganizationPlan): Promise<ApplyResult> {
    let moved = 0;
    let directRenamed = 0;
    let copiedFallback = 0;
    const skipped: SkippedFile[] = [];
    const failed: MoveFailure[] = [];
    let cleanupRemoved = 0;
    let cleanupJunkRemoved = 0;
    let cleanupScanned = 0;
    let cleanupSkipped: SkippedFile[] = [];
    let cleanupFailed: FolderCleanupFailure[] = [];
    let cleanupRemaining: RemainingFolder[] = [];

    for (const move of plan.moves) {
      const currentFile = this.app.vault.getAbstractFileByPath(move.source);
      if (!(currentFile instanceof TFile)) {
        skipped.push({ path: move.source, reason: "File was already moved or no longer exists" });
        continue;
      }

      try {
        await this.ensureFolder(parentPath(move.target));
        const moveMethod = await this.renameFile(currentFile, move);
        moved += 1;
        if (moveMethod === "direct-vault-rename") {
          directRenamed += 1;
        }
        if (moveMethod === "copy-delete") {
          copiedFallback += 1;
        }
      } catch (error) {
        console.error("Vault Reorganizer failed to move file", {
          source: move.source,
          target: move.target,
          error: formatUnknownError(error)
        });
        failed.push({
          source: move.source,
          target: move.target,
          error: formatUnknownError(error)
        });
      }
    }

    if (this.settings.removeEmptyFolders) {
      const cleanup = await this.removeEmptyFolders();
      cleanupRemoved = cleanup.removed;
      cleanupJunkRemoved = cleanup.junkRemoved;
      cleanupScanned = cleanup.scanned;
      cleanupSkipped = cleanup.skipped;
      cleanupFailed = cleanup.failed;
      cleanupRemaining = cleanup.remaining;
    }

    return {
      planKind: plan.kind,
      planLabel: plan.label,
      moved,
      directRenamed,
      copiedFallback,
      skipped,
      failed,
      cleanupRemoved,
      cleanupJunkRemoved,
      cleanupScanned,
      cleanupSkipped,
      cleanupFailed,
      cleanupRemaining
    };
  }

  async applyHandwritingPlan(plan: HandwritingPlan): Promise<ApplyResult> {
    let created = 0;
    const skipped: SkippedFile[] = [];
    const failed: MoveFailure[] = [];

    for (const note of plan.notes) {
      if (!this.isSafeHandwritingNoteTarget(note.target)) {
        skipped.push({ path: note.target, reason: "Markdown note target is outside the handwritten notes folder or is not a .md file" });
        continue;
      }

      const sourceFile = this.app.vault.getAbstractFileByPath(note.source);
      if (!(sourceFile instanceof TFile)) {
        skipped.push({ path: note.source, reason: "Source image was moved or no longer exists" });
        continue;
      }

      try {
        if (await this.app.vault.adapter.exists(note.target)) {
          skipped.push({ path: note.target, reason: "Markdown note already exists" });
          continue;
        }

        await this.ensureFolder(parentPath(note.target));
        await this.app.vault.create(note.target, note.markdown);
        created += 1;
      } catch (error) {
        failed.push({
          source: note.source,
          target: note.target,
          error: formatUnknownError(error)
        });
      }
    }

    return {
      planKind: plan.kind,
      planLabel: plan.label,
      moved: created,
      directRenamed: 0,
      copiedFallback: 0,
      skipped,
      failed,
      cleanupRemoved: 0,
      cleanupJunkRemoved: 0,
      cleanupScanned: 0,
      cleanupSkipped: [],
      cleanupFailed: [],
      cleanupRemaining: []
    };
  }

  isSafeHandwritingNoteTarget(target: string): boolean {
    const normalizedTarget = normalizePath(target);
    const notesFolder = getHandwritingNotesFolder(this.settings);
    return (
      normalizedTarget.toLowerCase().endsWith(".md") &&
      notesFolder.length > 0 &&
      pathStartsWithFolder(normalizedTarget, notesFolder)
    );
  }

  async renameFile(currentFile: TFile, move: PlannedMove): Promise<"file-manager" | "direct-vault-rename" | "copy-delete"> {
    try {
      await this.app.fileManager.renameFile(currentFile, move.target);
      return "file-manager";
    } catch (error) {
      if (!isFolderAlreadyExistsError(error)) {
        throw error;
      }

      const refreshedFile = this.app.vault.getAbstractFileByPath(move.source);
      const fallbackFile = refreshedFile instanceof TFile ? refreshedFile : currentFile;

      try {
        await this.app.vault.rename(fallbackFile, move.target);
        return "direct-vault-rename";
      } catch (fallbackError) {
        try {
          await this.copyThenDeleteFile(fallbackFile, move.target);
          return "copy-delete";
        } catch (copyError) {
          throw new Error(
            `${formatUnknownError(error)} Direct vault rename fallback also failed: ${formatUnknownError(
              fallbackError
            )}. Copy/delete fallback also failed: ${formatUnknownError(copyError)}`
          );
        }
      }
    }
  }

  async copyThenDeleteFile(file: TFile, target: string): Promise<void> {
    if (await this.app.vault.adapter.exists(target)) {
      throw new Error(`Target already exists: ${target}`);
    }

    await this.ensureFolder(parentPath(target));
    const data = await this.app.vault.adapter.readBinary(file.path);
    await this.app.vault.createBinary(target, data);

    const currentFile = this.app.vault.getAbstractFileByPath(file.path);
    if (currentFile instanceof TFile) {
      await this.trashOrRemove(currentFile);
      return;
    }

    await this.app.vault.adapter.remove(file.path);
  }

  async trashOrRemove(file: TAbstractFile): Promise<void> {
    const fileManager = this.app.fileManager as FileManagerWithOptionalTrash;
    const trashFile = fileManager["trashFile"];

    if (typeof trashFile === "function") {
      await trashFile.call(fileManager, file);
      return;
    }

    if (file instanceof TFile) {
      await this.app.vault.adapter.remove(file.path);
      return;
    }

    if (file instanceof TFolder) {
      await this.app.vault.adapter.rmdir(file.path, false);
      return;
    }

    throw new Error(`Could not remove unsupported file type: ${file.path}`);
  }

  chooseTarget(file: TFile, strategy: StrategyId): TargetChoice | null {
    const extension = file.extension.toLowerCase();

    if (this.isTemplate(file)) {
      return {
        folder: this.settings.templatesFolder,
        category: "template",
        reason: "Template folder match"
      };
    }

    if (this.isImage(file)) {
      return {
        folder: this.settings.imagesFolder,
        category: "image",
        reason: "Image file"
      };
    }

    if (this.isVideo(file)) {
      return {
        folder: this.settings.videosFolder,
        category: "video",
        reason: "Video file"
      };
    }

    if (this.isSound(file)) {
      return {
        folder: this.settings.soundFolder,
        category: "sound",
        reason: "Sound file"
      };
    }

    if (this.isAttachment(file)) {
      return {
        folder: this.settings.attachmentsFolder,
        category: "attachment",
        reason: "Attachment extension"
      };
    }

    if (strategy === "attachments-only") {
      return null;
    }

    if (extension === "md") {
      return {
        folder: strategy === "flat-root" ? "" : this.settings.markdownFolder,
        category: "note",
        reason: strategy === "flat-root" ? "Markdown note to vault root" : "Markdown note"
      };
    }

    if (extension === "canvas") {
      return {
        folder: this.settings.canvasesFolder,
        category: "canvas",
        reason: "Canvas file"
      };
    }

    if (extension === "base") {
      return {
        folder: this.settings.basesFolder,
        category: "base",
        reason: "Bases file"
      };
    }

    return {
      folder: this.settings.otherFilesFolder,
      category: "other",
      reason: "Other file type"
    };
  }

  isTemplate(file: TFile): boolean {
    if (file.extension.toLowerCase() !== "md") {
      return false;
    }

    return parseCsv(this.settings.templateFolders)
      .map(cleanFolderPath)
      .filter(Boolean)
      .some((folder) => pathStartsWithFolder(file.path, folder));
  }

  isAttachment(file: TFile): boolean {
    const extension = file.extension.toLowerCase();
    return parseExtensions(this.settings.attachmentExtensions).has(extension);
  }

  isImage(file: TFile): boolean {
    const extension = file.extension.toLowerCase();
    return parseExtensions(this.settings.imageExtensions).has(extension);
  }

  isVideo(file: TFile): boolean {
    const extension = file.extension.toLowerCase();
    return parseExtensions(this.settings.videoExtensions).has(extension);
  }

  isSound(file: TFile): boolean {
    const extension = file.extension.toLowerCase();
    return parseExtensions(this.settings.soundExtensions).has(extension);
  }

  shouldRenameImage(file: TFile): boolean {
    return !hasHumanReadableImageName(file);
  }

  canAnalyzeImage(file: TFile): boolean {
    return this.isImageRenameExtension(file) && file.stat.size <= MAX_IMAGE_RENAME_BYTES;
  }

  isImageRenameExtension(file: TFile): boolean {
    const extension = file.extension.toLowerCase();
    return parseExtensions(this.settings.imageRenameExtensions).has(extension) && Boolean(getImageRenameMimeType(extension));
  }

  isHandwritingExtension(file: TFile): boolean {
    const extension = file.extension.toLowerCase();
    return parseExtensions(this.settings.handwritingExtensions).has(extension) && Boolean(getHandwritingMimeType(extension));
  }

  shouldSplitOversizedHandwritingPdf(file: TFile): boolean {
    return this.canSplitOversizedHandwritingPdf(file);
  }

  canSplitOversizedHandwritingPdf(file: TFile): boolean {
    return (
      this.settings.splitOversizedHandwritingPdfs !== false &&
      file.extension.toLowerCase() === "pdf" &&
      file.stat.size > MAX_HANDWRITING_FILE_BYTES
    );
  }

  resolveHandwritingSourceFiles(skipped: SkippedFile[]): TFile[] {
    const requestedPaths = parseSourceFileReferences(this.settings.handwritingSourceFiles);
    if (requestedPaths.length === 0) {
      return [];
    }

    const resolvedFiles: TFile[] = [];
    const seen = new Set<string>();
    const vaultFiles = this.app.vault.getFiles();

    for (const requestedPath of requestedPaths) {
      const file = this.resolveVaultFileReference(requestedPath, vaultFiles);
      if (!file) {
        skipped.push({ path: requestedPath, reason: "Listed source file was not found" });
        continue;
      }

      if (this.isExcluded(file.path)) {
        skipped.push({ path: file.path, reason: "Listed source file is excluded" });
        continue;
      }

      if (!this.isHandwritingExtension(file)) {
        skipped.push({ path: file.path, reason: "Listed source file format is not enabled for handwriting conversion" });
        continue;
      }

      if (seen.has(file.path)) {
        continue;
      }

      seen.add(file.path);
      resolvedFiles.push(file);
    }

    return resolvedFiles;
  }

  resolveVaultFileReference(requestedPath: string, vaultFiles: TFile[]): TFile | null {
    const normalizedRequestedPath = normalizePath(requestedPath.replace(/^\/+/, ""));
    const directFile = this.app.vault.getAbstractFileByPath(normalizedRequestedPath);
    if (directFile instanceof TFile) {
      return directFile;
    }

    const requestedBaseName = baseName(normalizedRequestedPath).toLowerCase();
    const matches = vaultFiles.filter((file) => file.name.toLowerCase() === requestedBaseName);
    return matches.length === 1 ? matches[0] : null;
  }

  async requestImageSubjectName(file: TFile): Promise<string | null> {
    const mimeType = getImageRenameMimeType(file.extension);
    if (!mimeType) {
      return null;
    }

    const data = await this.app.vault.adapter.readBinary(file.path);
    const imageUrl = `data:${mimeType};base64,${arrayBufferToBase64(data)}`;
    const response = await requestUrl({
      url: OPENAI_RESPONSES_URL,
      method: "POST",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${this.settings.openAiApiKey.trim()}`
      },
      body: JSON.stringify({
        model: this.settings.imageRenameModel.trim() || DEFAULT_SETTINGS.imageRenameModel,
        store: false,
        max_output_tokens: 80,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "Name the main visible subject of this image for a file name. " +
                  "Return only JSON like {\"subject\":\"short subject\"}. " +
                  "Use 2 to 5 plain words. Avoid dates, camera words, generic words like image or photo, and invented personal names."
              },
              {
                type: "input_image",
                image_url: imageUrl,
                detail: this.settings.imageRenameDetail
              }
            ]
          }
        ]
      }),
      throw: false
    });

    const responseText = response.text;
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenAI image naming failed (${response.status}): ${redactSecretLikeText(responseText)}`);
    }

    const parsed = safeParseJson(responseText);
    return parseImageSubjectFromResponse(parsed);
  }

  async requestImageSubjectNameWithRetry(file: TFile): Promise<string | null> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.requestImageSubjectName(file);
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await sleep(600);
        }
      }
    }

    throw lastError;
  }

  async requestHandwritingMarkdown(file: TFile, forceHandwriting: boolean): Promise<HandwritingExtraction> {
    const mimeType = getHandwritingMimeType(file.extension);
    if (!mimeType) {
      return { isHandwrittenNote: false, title: "", markdown: "" };
    }

    const data = await this.app.vault.adapter.readBinary(file.path);
    const fileData = `data:${mimeType};base64,${arrayBufferToBase64(data)}`;
    const fileContent: OpenAIHandwritingContentPart =
      mimeType === "application/pdf"
        ? {
            type: "input_file",
            filename: file.name,
            file_data: fileData
          }
        : {
            type: "input_image",
            image_url: fileData,
            detail: this.settings.handwritingDetail
          };

    return this.requestOpenAiHandwritingExtraction(
      [
        {
          type: "input_text",
          text: buildHandwritingPrompt(forceHandwriting, mimeType === "application/pdf")
        },
        fileContent
      ],
      3000
    );
  }

  async requestSplitPdfHandwritingMarkdown(file: TFile, forceHandwriting: boolean): Promise<HandwritingExtraction> {
    const pages = await this.renderPdfPagesForHandwriting(file);
    if (pages.length === 0) {
      return { isHandwrittenNote: false, title: "", markdown: "" };
    }

    return this.requestOpenAiHandwritingExtraction(
      [
        {
          type: "input_text",
          text: buildSplitPdfHandwritingPrompt(forceHandwriting, file.name, pages.length)
        },
        ...pages.map(
          (page): OpenAIHandwritingContentPart => ({
            type: "input_image",
            image_url: page.imageUrl,
            detail: this.settings.handwritingDetail
          })
        )
      ],
      Math.min(16000, Math.max(4000, pages.length * 1200))
    );
  }

  async renderPdfPagesForHandwriting(file: TFile): Promise<RenderedPdfPageImage[]> {
    if (typeof document === "undefined") {
      throw new Error("PDF splitting requires the Obsidian desktop or mobile app renderer.");
    }

    const data = await this.app.vault.adapter.readBinary(file.path);
    const pdfJs = await loadPdfJsRuntime();
    let pdf: PdfDocumentForRendering | null = null;

    try {
      const loadingTask = pdfJs.getDocument({
        data: new Uint8Array(data),
        verbosity: pdfJs.VerbosityLevel.ERRORS,
        useSystemFonts: true,
        useWorkerFetch: false,
        isOffscreenCanvasSupported: false,
        isImageDecoderSupported: false
      });
      pdf = (await loadingTask.promise) as PdfDocumentForRendering;
      const maxPages = normalizePositiveInteger(
        this.settings.handwritingPdfPageLimit,
        DEFAULT_SETTINGS.handwritingPdfPageLimit
      );
      if (pdf.numPages > maxPages) {
        throw new Error(
          `PDF has ${pdf.numPages} pages; split handwriting conversion is limited to ${maxPages} pages per note. Increase the PDF page limit or split the PDF manually.`
        );
      }

      const pages: RenderedPdfPageImage[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        try {
          pages.push(await renderPdfPageForHandwriting(page, pageNumber, this.settings.handwritingDetail));
        } finally {
          page.cleanup();
        }
      }

      return pages;
    } finally {
      if (pdf) {
        await Promise.resolve(pdf.destroy());
      }
      pdfJs.restoreWorkerGlobal();
    }
  }

  async requestOpenAiHandwritingExtraction(
    content: OpenAIHandwritingContentPart[],
    maxOutputTokens: number
  ): Promise<HandwritingExtraction> {
    const response = await requestUrl({
      url: OPENAI_RESPONSES_URL,
      method: "POST",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${this.settings.openAiApiKey.trim()}`
      },
      body: JSON.stringify({
        model: this.settings.handwritingModel.trim() || DEFAULT_SETTINGS.handwritingModel,
        store: false,
        max_output_tokens: maxOutputTokens,
        input: [
          {
            role: "user",
            content
          }
        ]
      }),
      throw: false
    });

    const responseText = response.text;
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenAI handwriting conversion failed (${response.status}): ${redactSecretLikeText(responseText)}`);
    }

    return parseHandwritingExtraction(safeParseJson(responseText));
  }

  async requestHandwritingMarkdownWithRetry(file: TFile, forceHandwriting: boolean): Promise<HandwritingExtraction> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.requestHandwritingMarkdown(file, forceHandwriting);
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await sleep(600);
        }
      }
    }

    throw lastError;
  }

  async requestSplitPdfHandwritingMarkdownWithRetry(
    file: TFile,
    forceHandwriting: boolean
  ): Promise<HandwritingExtraction> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.requestSplitPdfHandwritingMarkdown(file, forceHandwriting);
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await sleep(600);
        }
      }
    }

    throw lastError;
  }

  isExcluded(path: string): boolean {
    if (isHiddenPath(path)) {
      return true;
    }

    if (pathStartsWithFolder(path, this.app.vault.configDir)) {
      return true;
    }

    if (pathStartsWithFolder(path, REPORTS_FOLDER)) {
      return true;
    }

    return parseCsv(this.settings.excludedFolders)
      .map(cleanFolderPath)
      .filter(Boolean)
      .some((folder) => pathStartsWithFolder(path, folder));
  }

  async findAvailablePath(sourcePath: string, desiredPath: string, proposedTargets: Set<string>): Promise<string> {
    const normalizedDesired = normalizePath(desiredPath);
    if (normalizePath(sourcePath) === normalizedDesired) {
      return normalizedDesired;
    }

    if (await this.isAvailableTarget(sourcePath, normalizedDesired, proposedTargets)) {
      return normalizedDesired;
    }

    const folder = parentPath(normalizedDesired);
    const fileName = baseName(normalizedDesired);
    const extensionStart = fileName.lastIndexOf(".");
    const name = extensionStart > 0 ? fileName.substring(0, extensionStart) : fileName;
    const extension = extensionStart > 0 ? fileName.substring(extensionStart) : "";

    for (let index = 2; index < 10000; index += 1) {
      const candidate = joinPath(folder, `${name} ${index}${extension}`);
      if (normalizePath(sourcePath) === candidate) {
        return candidate;
      }

      if (await this.isAvailableTarget(sourcePath, candidate, proposedTargets)) {
        return candidate;
      }
    }

    throw new Error(`Could not find an available path for ${desiredPath}`);
  }

  async isAvailableTarget(sourcePath: string, targetPath: string, proposedTargets: Set<string>): Promise<boolean> {
    const normalizedSource = normalizePath(sourcePath);
    const normalizedTarget = normalizePath(targetPath);

    if (normalizedSource === normalizedTarget) {
      return true;
    }

    if (proposedTargets.has(normalizedTarget)) {
      return false;
    }

    if (await this.app.vault.adapter.exists(normalizedTarget)) {
      return false;
    }

    const folderNoteCollision = folderPathForFileStem(normalizedTarget);
    if (!folderNoteCollision || normalizedSource === folderNoteCollision) {
      return true;
    }

    const existingFolder = this.app.vault.getAbstractFileByPath(folderNoteCollision);
    return !(existingFolder instanceof TFolder);
  }

  async findAvailableNewPath(desiredPath: string, proposedTargets: Set<string>): Promise<string> {
    const normalizedDesired = normalizePath(desiredPath);

    if (await this.isAvailableNewTarget(normalizedDesired, proposedTargets)) {
      return normalizedDesired;
    }

    const folder = parentPath(normalizedDesired);
    const fileName = baseName(normalizedDesired);
    const extensionStart = fileName.lastIndexOf(".");
    const name = extensionStart > 0 ? fileName.substring(0, extensionStart) : fileName;
    const extension = extensionStart > 0 ? fileName.substring(extensionStart) : "";

    for (let index = 2; index < 10000; index += 1) {
      const candidate = joinPath(folder, `${name} ${index}${extension}`);
      if (await this.isAvailableNewTarget(candidate, proposedTargets)) {
        return candidate;
      }
    }

    throw new Error(`Could not find an available path for ${desiredPath}`);
  }

  async isAvailableNewTarget(targetPath: string, proposedTargets: Set<string>): Promise<boolean> {
    const normalizedTarget = normalizePath(targetPath);

    if (proposedTargets.has(normalizedTarget)) {
      return false;
    }

    if (await this.app.vault.adapter.exists(normalizedTarget)) {
      return false;
    }

    const folderNoteCollision = folderPathForFileStem(normalizedTarget);
    if (!folderNoteCollision) {
      return true;
    }

    const existingFolder = this.app.vault.getAbstractFileByPath(folderNoteCollision);
    return !(existingFolder instanceof TFolder);
  }

  async ensureFolder(folderPath: string): Promise<void> {
    const cleanPath = cleanFolderPath(folderPath);
    if (!cleanPath) {
      return;
    }

    const parts = cleanPath.split("/");
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);

      if (existing instanceof TFile) {
        throw new Error(`Cannot create folder because a file exists at ${current}`);
      }

      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async removeEmptyFolders(): Promise<FolderCleanupResult> {
    const result: FolderCleanupResult = {
      removed: 0,
      junkRemoved: 0,
      skipped: [],
      failed: [],
      remaining: [],
      scanned: 0
    };
    const folders = Array.from(
      new Set([...this.collectIndexedFolderPaths(), ...(await this.collectFolderPaths("", result))])
    )
      .filter(Boolean)
      .filter((folderPath) => !this.isExcluded(folderPath))
      .sort((a, b) => pathDepth(b) - pathDepth(a) || b.length - a.length);

    for (const folderPath of folders) {
      result.scanned += 1;

      if (this.isExcluded(folderPath)) {
        continue;
      }

      if (this.isProtectedCleanupFolder(folderPath)) {
        continue;
      }

      try {
        let listed = await this.app.vault.adapter.list(folderPath);
        if (this.settings.removeJunkFilesBeforeFolderCleanup && listed.files.length > 0) {
          const removedJunk = await this.removeCleanupJunkFiles(listed.files, result);
          if (removedJunk > 0) {
            result.junkRemoved += removedJunk;
            listed = await this.app.vault.adapter.list(folderPath);
          }
        }

        if (listed.files.length > 0 || listed.folders.length > 0) {
          result.remaining.push({
            path: folderPath,
            files: listed.files.length,
            folders: listed.folders.length,
            hiddenPaths: findHiddenBlockers(listed.files, listed.folders)
          });
          continue;
        }

        await this.deleteEmptyFolder(folderPath);
        result.removed += 1;
      } catch (error) {
        const message = formatUnknownError(error);
        if (message.includes("ENOENT")) {
          continue;
        }

        if (message.includes("ENOTEMPTY")) {
          result.skipped.push({ path: folderPath, reason: "Directory is not empty" });
          continue;
        }

        console.error("Vault Reorganizer failed to remove empty folder", {
          path: folderPath,
          error: message
        });
        result.failed.push({ path: folderPath, error: message });
      }
    }

    return result;
  }

  async removeCleanupJunkFiles(files: string[], result: FolderCleanupResult): Promise<number> {
    let removed = 0;

    for (const filePath of files) {
      if (isHiddenPath(filePath)) {
        continue;
      }

      const fileName = baseName(filePath).toLowerCase();
      if (!CLEANUP_JUNK_FILE_NAMES.has(fileName)) {
        continue;
      }

      try {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          await this.trashOrRemove(file);
        } else {
          await this.app.vault.adapter.remove(filePath);
        }
        removed += 1;
      } catch (error) {
        result.failed.push({
          path: filePath,
          error: `Could not remove OS metadata file: ${formatUnknownError(error)}`
        });
      }
    }

    return removed;
  }

  async deleteEmptyFolder(folderPath: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (folder instanceof TFolder) {
      await this.trashOrRemove(folder);
      return;
    }

    await this.app.vault.adapter.rmdir(folderPath, false);
  }

  async collectFolderPaths(folderPath: string, result: FolderCleanupResult): Promise<string[]> {
    let listed: { files: string[]; folders: string[] };
    try {
      listed = await this.app.vault.adapter.list(folderPath);
    } catch (error) {
      result.failed.push({
        path: folderPath || "/",
        error: `Could not scan folder: ${formatUnknownError(error)}`
      });
      return [];
    }

    const folders = listed.folders
      .map((path) => normalizePath(path))
      .filter((path) => !this.isExcluded(path));
    const nestedFolders: string[] = [];

    for (const folder of folders) {
      nestedFolders.push(...(await this.collectFolderPaths(folder, result)));
    }

    return [...folders, ...nestedFolders];
  }

  collectIndexedFolderPaths(): string[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file: TAbstractFile): file is TFolder => file instanceof TFolder)
      .map((folder) => folder.path)
      .filter(Boolean)
      .map((path) => normalizePath(path))
      .filter((path) => !this.isExcluded(path));
  }

  isProtectedCleanupFolder(folderPath: string): boolean {
    const normalizedFolder = cleanFolderPath(folderPath).toLowerCase();
    return this.getProtectedCleanupFolders().some((protectedFolder) => protectedFolder.toLowerCase() === normalizedFolder);
  }

  getProtectedCleanupFolders(): string[] {
    return [
      this.settings.markdownFolder,
      this.settings.imagesFolder,
      this.settings.videosFolder,
      this.settings.soundFolder,
      this.settings.attachmentsFolder,
      this.settings.templatesFolder,
      this.settings.canvasesFolder,
      this.settings.basesFolder,
      this.settings.otherFilesFolder
    ]
      .map(cleanFolderPath)
      .filter(Boolean);
  }
}

class ConfirmationModal extends Modal {
  private readonly title: string;
  private readonly message: string;
  private readonly confirmText: string;
  private readonly resolve: (confirmed: boolean) => void;
  private resolved = false;

  constructor(app: App, title: string, message: string, confirmText: string, resolve: (confirmed: boolean) => void) {
    super(app);
    this.title = title;
    this.message = message;
    this.confirmText = confirmText;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(this.title).setHeading();
    contentEl.createEl("p", { text: this.message });

    const buttonRow = contentEl.createDiv({ cls: "vault-reorganizer-confirm-buttons" });
    new ButtonComponent(buttonRow)
      .setButtonText("Cancel")
      .onClick(() => {
        this.finish(false);
      });
    new ButtonComponent(buttonRow)
      .setButtonText(this.confirmText)
      .setCta()
      .onClick(() => {
        this.finish(true);
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish(false);
  }

  private finish(confirmed: boolean): void {
    if (this.resolved) {
      return;
    }

    this.resolved = true;
    this.resolve(confirmed);
    this.close();
  }
}

function confirmAction(app: App, title: string, message: string, confirmText: string): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmationModal(app, title, message, confirmText, resolve).open();
  });
}

class ReorganizerModal extends Modal {
  plugin: VaultReorganizerPlugin;
  strategy: StrategyId;
  plan: ActivePlan | null = null;
  lastResult: ApplyResult | null = null;
  summaryEl: HTMLElement;
  previewEl: HTMLElement;
  applyButton: ButtonComponent;
  cleanupButton: ButtonComponent;
  copyReportButton: ButtonComponent;
  createReportButton: ButtonComponent;

  constructor(app: App, plugin: VaultReorganizerPlugin) {
    super(app);
    this.plugin = plugin;
    this.strategy = plugin.settings.strategy;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("vault-reorganizer-modal");

    new Setting(this.contentEl).setName("Vault reorganization planner").setHeading();

    new Setting(this.contentEl)
      .setName("Strategy")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(STRATEGY_LABELS)
          .setValue(this.strategy)
          .onChange((value) => {
            this.strategy = value as StrategyId;
            this.plan = null;
            this.renderEmptyPreview();
          });
      });

    new Setting(this.contentEl)
      .setName("Remove empty folders after applying")
      .setDesc("Keeps the configured destination folders, such as Notes and Attachments.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.removeEmptyFolders).onChange(async (value) => {
          this.plugin.settings.removeEmptyFolders = value;
          await this.plugin.saveSettings();
          this.plan = null;
          this.renderEmptyPreview();
        });
      });

    new Setting(this.contentEl)
      .setName("Remove visible OS metadata files during cleanup")
      .setDesc("Only removes visible metadata names such as Thumbs.db and desktop.ini. Dotfiles and hidden folders are always ignored.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.removeJunkFilesBeforeFolderCleanup).onChange(async (value) => {
          this.plugin.settings.removeJunkFilesBeforeFolderCleanup = value;
          await this.plugin.saveSettings();
        });
      });

    const buttonRow = this.contentEl.createDiv({ cls: "vault-reorganizer-button-row" });
    new ButtonComponent(buttonRow)
      .setButtonText("Generate preview")
      .setCta()
      .onClick(async () => {
        await this.generatePreview();
      });

    new ButtonComponent(buttonRow)
      .setButtonText("Generate image rename preview")
      .onClick(async () => {
        await this.generateImageRenamePreview();
      });

    new ButtonComponent(buttonRow)
      .setButtonText("Generate handwriting Markdown preview")
      .onClick(async () => {
        await this.generateHandwritingPreview();
      });

    this.applyButton = new ButtonComponent(buttonRow)
      .setButtonText("Apply previewed moves")
      .setDisabled(true)
      .onClick(async () => {
        await this.applyPreviewedMoves();
      });

    this.cleanupButton = new ButtonComponent(buttonRow)
      .setButtonText("Remove empty folders now")
      .onClick(async () => {
        await this.removeEmptyFoldersOnly();
      });

    this.copyReportButton = new ButtonComponent(buttonRow)
      .setButtonText("Copy last report")
      .setDisabled(true)
      .onClick(async () => {
        await this.copyLastReport();
      });

    this.createReportButton = new ButtonComponent(buttonRow)
      .setButtonText("Create report note")
      .setDisabled(true)
      .onClick(async () => {
        await this.createReportNote();
      });

    this.summaryEl = this.contentEl.createDiv({ cls: "vault-reorganizer-summary" });
    this.previewEl = this.contentEl.createDiv({ cls: "vault-reorganizer-preview" });
    this.renderEmptyPreview();
  }

  async generatePreview(): Promise<void> {
    this.applyButton.setDisabled(true);
    this.summaryEl.setText("Scanning vault...");
    this.previewEl.empty();

    try {
      this.plan = await this.plugin.buildPlan(this.strategy);
      this.lastResult = null;
      this.plugin.lastPlan = this.plan;
      this.renderPlan();
    } catch (error) {
      console.error(error);
      this.summaryEl.setText(error instanceof Error ? error.message : "Preview failed.");
      new Notice("Vault reorganization preview failed.");
    }
  }

  async generateImageRenamePreview(): Promise<void> {
    const confirmed = await confirmAction(
      this.app,
      "Generate image rename preview",
      `Analyze up to ${normalizePositiveInteger(
        this.plugin.settings.imageRenameMaxFiles,
        DEFAULT_SETTINGS.imageRenameMaxFiles
      )} generic image filenames with OpenAI now? The preview will also move image files into ${cleanFolderPath(
        this.plugin.settings.imagesFolder
      ) || "the vault root"}.`,
      "Generate preview"
    );
    if (!confirmed) {
      return;
    }

    this.applyButton.setDisabled(true);
    this.summaryEl.setText("Scanning images...");
    this.previewEl.empty();

    try {
      this.plan = await this.plugin.buildImageRenamePlan((completed, total, path) => {
        this.summaryEl.setText(`Naming image ${completed} of ${total}: ${path}`);
      });
      this.lastResult = null;
      this.plugin.lastPlan = this.plan;
      this.renderPlan();
    } catch (error) {
      console.error(error);
      this.summaryEl.setText(error instanceof Error ? error.message : "Image rename preview failed.");
      new Notice("Image rename preview failed.");
    }
  }

  async generateHandwritingPreview(): Promise<void> {
    const requestedFiles = parseSourceFileReferences(this.plugin.settings.handwritingSourceFiles);
    const sourceFolders = parseSourceFolders(
      this.plugin.settings.handwritingSourceFolder || DEFAULT_SETTINGS.handwritingSourceFolder
    );
    const sourceLabel = sourceFolders.length > 0 ? sourceFolders.join(", ") : "the vault";
    const scopeText =
      requestedFiles.length > 0
        ? `${requestedFiles.length} specifically listed file${requestedFiles.length === 1 ? "" : "s"}`
        : `up to ${normalizePositiveInteger(
            this.plugin.settings.handwritingMaxFiles,
            DEFAULT_SETTINGS.handwritingMaxFiles
          )} supported images/PDFs in ${sourceLabel}`;
    const confirmed = await confirmAction(
      this.app,
      "Generate handwriting preview",
      `Analyze ${scopeText} and create a Markdown preview for handwritten notes?`,
      "Generate preview"
    );
    if (!confirmed) {
      return;
    }

    this.applyButton.setDisabled(true);
    this.summaryEl.setText("Scanning handwriting files...");
    this.previewEl.empty();

    try {
      this.plan = await this.plugin.buildHandwritingPlan((completed, total, path) => {
        this.summaryEl.setText(`Reading handwriting ${completed} of ${total}: ${path}`);
      });
      this.lastResult = null;
      this.plugin.lastPlan = this.plan;
      this.renderPlan();
    } catch (error) {
      console.error(error);
      this.summaryEl.setText(error instanceof Error ? error.message : "Handwriting preview failed.");
      new Notice("Handwriting Markdown preview failed.");
    }
  }

  renderEmptyPreview(): void {
    this.applyButton.setDisabled(true);
    this.applyButton.setButtonText("Apply previewed moves");
    this.cleanupButton.setDisabled(false);
    this.copyReportButton.setDisabled(!this.lastResult);
    this.createReportButton.setDisabled(!this.lastResult);
    this.summaryEl.setText("Generate a preview before applying any moves.");
    this.previewEl.empty();
  }

  renderPlan(): void {
    if (!this.plan) {
      return;
    }

    if (this.plan.kind === "handwriting") {
      this.renderHandwritingPlan(this.plan);
      return;
    }

    this.summaryEl.empty();
    const strategyName = this.plan.label;
    this.summaryEl.createEl("p", {
      text: `${strategyName}: ${this.plan.moves.length} file updates planned, ${this.plan.skipped.length} files skipped.`
    });

    for (const warning of this.plan.warnings) {
      this.summaryEl.createEl("p", { text: warning, cls: "vault-reorganizer-warning" });
    }

    this.previewEl.empty();

    if (this.plan.moves.length === 0) {
      this.previewEl.createEl("p", { text: "No file updates are needed for this preview." });
      this.applyButton.setDisabled(true);
      return;
    }

    const table = this.previewEl.createEl("table");
    const header = table.createEl("thead").createEl("tr");
    header.createEl("th", { text: "From" });
    header.createEl("th", { text: "To" });
    header.createEl("th", { text: "Why" });

    const body = table.createEl("tbody");
    for (const move of this.plan.moves.slice(0, MAX_PREVIEW_ROWS)) {
      const row = body.createEl("tr");
      row.createEl("td", { text: move.source, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: move.target, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: move.reason });
    }

    this.applyButton.setButtonText(
      this.plan.kind === "image-rename" ? "Apply previewed image updates" : "Apply previewed moves"
    );
    this.applyButton.setDisabled(false);
    this.cleanupButton.setDisabled(false);
    this.copyReportButton.setDisabled(!this.lastResult);
    this.createReportButton.setDisabled(!this.lastResult);
  }

  renderHandwritingPlan(plan: HandwritingPlan): void {
    this.summaryEl.empty();
    this.summaryEl.createEl("p", {
      text: `${plan.label}: ${plan.notes.length} Markdown notes planned, ${plan.skipped.length} files skipped.`
    });

    for (const warning of plan.warnings) {
      this.summaryEl.createEl("p", { text: warning, cls: "vault-reorganizer-warning" });
    }

    this.previewEl.empty();

    if (plan.notes.length === 0) {
      this.previewEl.createEl("p", { text: "No handwritten notes were detected in this preview." });
      this.applyButton.setDisabled(true);
      return;
    }

    const table = this.previewEl.createEl("table");
    const header = table.createEl("thead").createEl("tr");
    header.createEl("th", { text: "Image" });
    header.createEl("th", { text: "Markdown note" });
    header.createEl("th", { text: "Preview" });

    const body = table.createEl("tbody");
    for (const note of plan.notes.slice(0, MAX_PREVIEW_ROWS)) {
      const row = body.createEl("tr");
      row.createEl("td", { text: note.source, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: note.target, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: markdownExcerpt(note.markdown) });
    }

    this.applyButton.setButtonText("Create previewed Markdown notes");
    this.applyButton.setDisabled(false);
    this.cleanupButton.setDisabled(false);
    this.copyReportButton.setDisabled(!this.lastResult);
    this.createReportButton.setDisabled(!this.lastResult);
  }

  async applyPreviewedMoves(): Promise<void> {
    if (!this.plan || getPlanItemCount(this.plan) === 0) {
      return;
    }

    const itemCount = getPlanItemCount(this.plan);
    const confirmationText =
      this.plan.kind === "handwriting"
        ? `Create ${itemCount} Markdown note${itemCount === 1 ? "" : "s"} in ${getHandwritingNotesFolder(
            this.plugin.settings
          )} now? Make sure the vault is backed up before continuing.`
        : `Apply ${itemCount} previewed item${itemCount === 1 ? "" : "s"} now? Make sure the vault is backed up before continuing.`;
    const confirmed = await confirmAction(this.app, "Apply preview", confirmationText, "Apply");
    if (!confirmed) {
      return;
    }

    this.applyButton.setDisabled(true);
    this.cleanupButton.setDisabled(true);
    this.copyReportButton.setDisabled(true);
    this.createReportButton.setDisabled(true);
    this.summaryEl.setText(this.plan.kind === "handwriting" ? "Creating Markdown notes..." : "Applying moves...");

    try {
      this.lastResult =
        this.plan.kind === "handwriting"
          ? await this.plugin.applyHandwritingPlan(this.plan)
          : await this.plugin.applyPlan(this.plan);
      this.renderApplyResult(this.lastResult);
      this.cleanupButton.setDisabled(false);
      this.copyReportButton.setDisabled(false);
      this.createReportButton.setDisabled(false);
      new Notice(formatApplyNotice(this.lastResult));
      this.plan = null;
    } catch (error) {
      console.error(error);
      this.summaryEl.setText(error instanceof Error ? error.message : "Move failed.");
      this.cleanupButton.setDisabled(false);
      new Notice("Vault reorganization failed before all moves completed.");
    }
  }

  async removeEmptyFoldersOnly(): Promise<void> {
    this.applyButton.setDisabled(true);
    this.cleanupButton.setDisabled(true);
    this.copyReportButton.setDisabled(true);
    this.createReportButton.setDisabled(true);
    this.summaryEl.setText("Removing empty folders...");
    this.previewEl.empty();

    try {
      const cleanup = await this.plugin.removeEmptyFolders();
      this.lastResult = emptyApplyResultFromCleanup(cleanup);
      this.renderCleanupResult(cleanup);
      this.applyButton.setDisabled(!this.plan || getPlanItemCount(this.plan) === 0);
      this.cleanupButton.setDisabled(false);
      this.copyReportButton.setDisabled(false);
      this.createReportButton.setDisabled(false);
      new Notice(formatCleanupNotice(cleanup));
    } catch (error) {
      console.error(error);
      this.summaryEl.setText(error instanceof Error ? error.message : "Empty-folder cleanup failed.");
      this.cleanupButton.setDisabled(false);
      new Notice("Empty-folder cleanup failed.");
    }
  }

  renderApplyResult(result: ApplyResult): void {
    this.summaryEl.empty();
    this.summaryEl.createEl("p", {
      text: formatApplyResultSummary(result)
    });

    if (result.directRenamed > 0) {
      this.summaryEl.createEl("p", {
        text:
          "Some files were moved with Obsidian's lower-level vault rename because the normal link-updating rename reported that a folder already existed.",
        cls: "vault-reorganizer-warning"
      });
    }

    if (result.copiedFallback > 0) {
      this.summaryEl.createEl("p", {
        text:
          "Some files were moved with a copy/delete fallback because both Obsidian rename methods refused the move. Those fallback moves do not run Obsidian's normal link-updating rename.",
        cls: "vault-reorganizer-warning"
      });
    }

    if (result.failed.some((failure) => failure.error.includes("EPERM"))) {
      this.summaryEl.createEl("p", {
        text:
          "EPERM usually means macOS, iCloud/Dropbox/OneDrive, or the filesystem blocked the rename. Check that Obsidian has permission to modify the vault and that the file is not locked or still syncing.",
        cls: "vault-reorganizer-warning"
      });
    }

    if (result.cleanupRemaining.length > 0 || result.cleanupSkipped.length > 0 || result.cleanupFailed.length > 0) {
      this.summaryEl.createEl("p", {
        text:
          "Some folders were left in place during empty-folder cleanup. The table shows folders that still contain files or subfolders, plus any cleanup errors.",
        cls: "vault-reorganizer-warning"
      });
    }

    this.previewEl.empty();

    if (
      result.failed.length === 0 &&
      result.skipped.length === 0 &&
      result.cleanupRemaining.length === 0 &&
      result.cleanupSkipped.length === 0 &&
      result.cleanupFailed.length === 0
    ) {
      this.previewEl.createEl("p", {
        text:
          result.planKind === "handwriting"
            ? "All previewed Markdown notes were created."
            : "All previewed moves completed."
      });
      return;
    }

    const table = this.previewEl.createEl("table");
    const header = table.createEl("thead").createEl("tr");
    header.createEl("th", { text: "Status" });
    header.createEl("th", { text: "From" });
    header.createEl("th", { text: "To / Reason" });
    header.createEl("th", { text: "Error" });

    const body = table.createEl("tbody");
    let rows = 0;
    for (const failure of result.failed) {
      if (rows >= MAX_FAILURE_ROWS) {
        break;
      }
      const row = body.createEl("tr");
      row.createEl("td", { text: result.planKind === "handwriting" ? "Create failed" : "Update failed" });
      row.createEl("td", { text: failure.source, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: failure.target, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: failure.error });
      rows += 1;
    }

    for (const skipped of result.skipped) {
      if (rows >= MAX_FAILURE_ROWS) {
        break;
      }
      const row = body.createEl("tr");
      row.createEl("td", { text: result.planKind === "handwriting" ? "Note skipped" : "File skipped" });
      row.createEl("td", { text: skipped.path, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: skipped.reason });
      row.createEl("td", { text: "" });
      rows += 1;
    }

    for (const skipped of result.cleanupSkipped) {
      if (rows >= MAX_FAILURE_ROWS) {
        break;
      }
      const row = body.createEl("tr");
      row.createEl("td", { text: "Cleanup skipped" });
      row.createEl("td", { text: skipped.path, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: skipped.reason });
      row.createEl("td", { text: "" });
      rows += 1;
    }

    for (const remaining of result.cleanupRemaining) {
      if (rows >= MAX_FAILURE_ROWS) {
        break;
      }
      const row = body.createEl("tr");
      row.createEl("td", { text: "Still not empty" });
      row.createEl("td", { text: remaining.path, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: formatRemainingFolderReason(remaining) });
      row.createEl("td", { text: "" });
      rows += 1;
    }

    for (const failure of result.cleanupFailed) {
      if (rows >= MAX_FAILURE_ROWS) {
        break;
      }
      const row = body.createEl("tr");
      row.createEl("td", { text: "Cleanup failed" });
      row.createEl("td", { text: failure.path, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: "Could not remove folder" });
      row.createEl("td", { text: failure.error });
      rows += 1;
    }
  }

  renderCleanupResult(result: FolderCleanupResult): void {
    this.summaryEl.empty();
    this.summaryEl.createEl("p", {
      text:
        `Scanned ${result.scanned} folders. Removed ${result.removed} empty folders. ` +
        `Removed ${result.junkRemoved} OS metadata files. ${result.remaining.length} still not empty. ` +
        `${countHiddenBlockers(result.remaining)} hidden blockers found. ` +
        `${result.skipped.length} skipped. ${result.failed.length} failed.`
    });

    if (result.remaining.length > 0 || result.skipped.length > 0 || result.failed.length > 0) {
      this.summaryEl.createEl("p", {
        text:
          "Some folders were left in place. The table shows folders that still contain files or subfolders, plus any cleanup errors.",
        cls: "vault-reorganizer-warning"
      });
    }

    this.previewEl.empty();

    if (result.remaining.length === 0 && result.skipped.length === 0 && result.failed.length === 0) {
      this.previewEl.createEl("p", { text: "Empty-folder cleanup completed." });
      return;
    }

    const table = this.previewEl.createEl("table");
    const header = table.createEl("thead").createEl("tr");
    header.createEl("th", { text: "Status" });
    header.createEl("th", { text: "Folder" });
    header.createEl("th", { text: "Reason" });

    const body = table.createEl("tbody");
    let rows = 0;

    for (const skipped of result.skipped) {
      if (rows >= MAX_FAILURE_ROWS) {
        break;
      }
      const row = body.createEl("tr");
      row.createEl("td", { text: "Skipped" });
      row.createEl("td", { text: skipped.path, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: skipped.reason });
      rows += 1;
    }

    for (const remaining of result.remaining) {
      if (rows >= MAX_FAILURE_ROWS) {
        break;
      }
      const row = body.createEl("tr");
      row.createEl("td", { text: "Still not empty" });
      row.createEl("td", { text: remaining.path, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: formatRemainingFolderReason(remaining) });
      rows += 1;
    }

    for (const failure of result.failed) {
      if (rows >= MAX_FAILURE_ROWS) {
        break;
      }
      const row = body.createEl("tr");
      row.createEl("td", { text: "Failed" });
      row.createEl("td", { text: failure.path, cls: "vault-reorganizer-path" });
      row.createEl("td", { text: failure.error });
      rows += 1;
    }
  }

  async copyLastReport(): Promise<void> {
    if (!this.lastResult) {
      return;
    }

    try {
      await writeTextToClipboard(formatApplyReport(this.lastResult));
      new Notice("Vault Reorganizer report copied.");
    } catch (error) {
      console.error(error);
      new Notice("Could not copy the report. Try Create report note instead.");
    }
  }

  async createReportNote(): Promise<void> {
    if (!this.lastResult) {
      return;
    }

    try {
      const reportPath = await this.createAvailableReportPath();
      await this.plugin.ensureFolder(parentPath(reportPath));
      const file = await this.app.vault.create(reportPath, formatApplyReport(this.lastResult));
      await this.app.workspace.getLeaf(true).openFile(file);
      new Notice(`Created ${reportPath}`);
    } catch (error) {
      console.error(error);
      new Notice("Could not create the report note.");
    }
  }

  async createAvailableReportPath(): Promise<string> {
    const folder = "Vault Reorganizer Reports";
    const timestamp = formatReportTimestamp(new Date());
    const basePath = joinPath(folder, `Vault Reorganizer Report ${timestamp}.md`);

    if (!(await this.app.vault.adapter.exists(basePath))) {
      return basePath;
    }

    for (let index = 2; index < 10000; index += 1) {
      const candidate = joinPath(folder, `Vault Reorganizer Report ${timestamp} ${index}.md`);
      if (!(await this.app.vault.adapter.exists(candidate))) {
        return candidate;
      }
    }

    throw new Error("Could not find an available report filename.");
  }
}

class VaultReorganizerSettingTab extends PluginSettingTab {
  plugin: VaultReorganizerPlugin;

  constructor(app: App, plugin: VaultReorganizerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Reorganization settings").setHeading();

    new Setting(containerEl)
      .setName("Default strategy")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(STRATEGY_LABELS)
          .setValue(this.plugin.settings.strategy)
          .onChange(async (value) => {
            this.plugin.settings.strategy = value as StrategyId;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Markdown destination")
      .setDesc("Leave blank to move Markdown notes to the vault root.")
      .addText((text) =>
        text
          .setPlaceholder("Notes")
          .setValue(this.plugin.settings.markdownFolder)
          .onChange(async (value) => {
            this.plugin.settings.markdownFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Attachments destination")
      .addText((text) =>
        text
          .setPlaceholder("Attachments")
          .setValue(this.plugin.settings.attachmentsFolder)
          .onChange(async (value) => {
            this.plugin.settings.attachmentsFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Images destination")
      .setDesc("Image files are moved here before the general attachments folder.")
      .addText((text) =>
        text
          .setPlaceholder("Images")
          .setValue(this.plugin.settings.imagesFolder)
          .onChange(async (value) => {
            this.plugin.settings.imagesFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Videos destination")
      .setDesc("Video files are moved here before the general attachments folder.")
      .addText((text) =>
        text
          .setPlaceholder("Videos")
          .setValue(this.plugin.settings.videosFolder)
          .onChange(async (value) => {
            this.plugin.settings.videosFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sound destination")
      .setDesc("Audio files are moved here before the general attachments folder.")
      .addText((text) =>
        text
          .setPlaceholder("Sound")
          .setValue(this.plugin.settings.soundFolder)
          .onChange(async (value) => {
            this.plugin.settings.soundFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Templates destination")
      .addText((text) =>
        text
          .setPlaceholder("Templates")
          .setValue(this.plugin.settings.templatesFolder)
          .onChange(async (value) => {
            this.plugin.settings.templatesFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Canvases destination")
      .addText((text) =>
        text
          .setPlaceholder("Canvases")
          .setValue(this.plugin.settings.canvasesFolder)
          .onChange(async (value) => {
            this.plugin.settings.canvasesFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Bases destination")
      .setDesc("Destination for Obsidian Bases .base files.")
      .addText((text) =>
        text
          .setPlaceholder("Bases")
          .setValue(this.plugin.settings.basesFolder)
          .onChange(async (value) => {
            this.plugin.settings.basesFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Other files destination")
      .addText((text) =>
        text
          .setPlaceholder("Files")
          .setValue(this.plugin.settings.otherFilesFolder)
          .onChange(async (value) => {
            this.plugin.settings.otherFilesFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Comma-separated folder names or paths.")
      .addText((text) =>
        text
          .setPlaceholder(`${this.app.vault.configDir},.trash,Archive`)
          .setValue(this.plugin.settings.excludedFolders)
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Template folders")
      .setDesc("Markdown files in these folders are treated as templates.")
      .addText((text) =>
        text
          .setPlaceholder("Templates,Template")
          .setValue(this.plugin.settings.templateFolders)
          .onChange(async (value) => {
            this.plugin.settings.templateFolders = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Attachment extensions")
      .setDesc("Comma-separated extensions without dots.")
      .addTextArea((text) =>
        text
          .setPlaceholder("png,jpg,jpeg,pdf,mp3,mp4")
          .setValue(this.plugin.settings.attachmentExtensions)
          .onChange(async (value) => {
            this.plugin.settings.attachmentExtensions = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Image extensions")
      .setDesc("These file types go to the Images destination.")
      .addTextArea((text) =>
        text
          .setPlaceholder("png,jpg,jpeg,gif,webp,svg,avif,bmp,heic")
          .setValue(this.plugin.settings.imageExtensions)
          .onChange(async (value) => {
            this.plugin.settings.imageExtensions = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Video extensions")
      .setDesc("These file types go to the Videos destination.")
      .addTextArea((text) =>
        text
          .setPlaceholder("mp4,mov,webm,mkv,avi,m4v")
          .setValue(this.plugin.settings.videoExtensions)
          .onChange(async (value) => {
            this.plugin.settings.videoExtensions = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sound extensions")
      .setDesc("These file types go to the Sound destination.")
      .addTextArea((text) =>
        text
          .setPlaceholder("mp3,wav,m4a,aac,flac,ogg,opus")
          .setValue(this.plugin.settings.soundExtensions)
          .onChange(async (value) => {
            this.plugin.settings.soundExtensions = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("OpenAI API key for image naming")
      .setDesc("Used for image naming and handwriting conversion. Stored locally in this plugin's Obsidian data file.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.openAiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.openAiApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Specific handwriting files")
      .setDesc("Optional. One path, filename, or wikilink per line. When set, only these files are checked.")
      .addTextArea((text) =>
        text
          .setPlaceholder("Attachments/OneNote scan.pdf\nImages/handwritten page.jpg")
          .setValue(this.plugin.settings.handwritingSourceFiles)
          .onChange(async (value) => {
            this.plugin.settings.handwritingSourceFiles = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Handwriting source folders")
      .setDesc("Comma-separated folders checked for handwritten images and PDFs.")
      .addText((text) =>
        text
          .setPlaceholder("Images,Attachments")
          .setValue(this.plugin.settings.handwritingSourceFolder)
          .onChange(async (value) => {
            this.plugin.settings.handwritingSourceFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Handwritten notes destination")
      .setDesc("Markdown notes created from handwriting are saved here.")
      .addText((text) =>
        text
          .setPlaceholder("Notes/Handwritten")
          .setValue(this.plugin.settings.handwritingNotesFolder)
          .onChange(async (value) => {
            this.plugin.settings.handwritingNotesFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Handwriting model")
      .setDesc("Used only when generating the handwriting Markdown preview.")
      .addText((text) =>
        text
          .setPlaceholder("gpt-5.5")
          .setValue(this.plugin.settings.handwritingModel)
          .onChange(async (value) => {
            this.plugin.settings.handwritingModel = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Handwriting file formats")
      .setDesc("OpenAI handwriting conversion supports PNG, JPEG, WebP, non-animated GIF, and PDF by default.")
      .addText((text) =>
        text
          .setPlaceholder("png,jpg,jpeg,webp,gif,pdf")
          .setValue(this.plugin.settings.handwritingExtensions)
          .onChange(async (value) => {
            this.plugin.settings.handwritingExtensions = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Maximum handwriting conversions per preview")
      .setDesc("Limits OpenAI calls during one handwriting preview.")
      .addText((text) =>
        text
          .setPlaceholder("50")
          .setValue(String(this.plugin.settings.handwritingMaxFiles))
          .onChange(async (value) => {
            this.plugin.settings.handwritingMaxFiles = normalizePositiveInteger(
              Number(value),
              DEFAULT_SETTINGS.handwritingMaxFiles
            );
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Split oversized handwriting PDFs")
      .setDesc("PDFs over 20 MB are rendered to temporary page images and converted into one Markdown note.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.splitOversizedHandwritingPdfs).onChange(async (value) => {
          this.plugin.settings.splitOversizedHandwritingPdfs = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Maximum PDF pages per handwriting note")
      .setDesc("Limits page images created from one oversized PDF.")
      .addText((text) =>
        text
          .setPlaceholder("25")
          .setValue(String(this.plugin.settings.handwritingPdfPageLimit))
          .onChange(async (value) => {
            this.plugin.settings.handwritingPdfPageLimit = normalizePositiveInteger(
              Number(value),
              DEFAULT_SETTINGS.handwritingPdfPageLimit
            );
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Handwriting detail")
      .setDesc("High is best for handwriting. Low is cheaper but may miss small text.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            low: "Low",
            auto: "Auto",
            high: "High"
          })
          .setValue(this.plugin.settings.handwritingDetail)
          .onChange(async (value) => {
            this.plugin.settings.handwritingDetail = value as ImageRenameDetail;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Image naming model")
      .setDesc("Used only when generating the image rename preview.")
      .addText((text) =>
        text
          .setPlaceholder("gpt-5.5")
          .setValue(this.plugin.settings.imageRenameModel)
          .onChange(async (value) => {
            this.plugin.settings.imageRenameModel = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Image naming formats")
      .setDesc("OpenAI image naming supports PNG, JPEG, WebP, and non-animated GIF by default.")
      .addText((text) =>
        text
          .setPlaceholder("png,jpg,jpeg,webp,gif")
          .setValue(this.plugin.settings.imageRenameExtensions)
          .onChange(async (value) => {
            this.plugin.settings.imageRenameExtensions = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Maximum image names per preview")
      .setDesc("Limits OpenAI calls during one preview. Images beyond the limit can still be moved to Images.")
      .addText((text) =>
        text
          .setPlaceholder("25")
          .setValue(String(this.plugin.settings.imageRenameMaxFiles))
          .onChange(async (value) => {
            this.plugin.settings.imageRenameMaxFiles = normalizePositiveInteger(
              Number(value),
              DEFAULT_SETTINGS.imageRenameMaxFiles
            );
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Image naming detail")
      .setDesc("Low is usually enough for subject-based filenames and keeps image analysis cheaper.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            low: "Low",
            auto: "Auto",
            high: "High"
          })
          .setValue(this.plugin.settings.imageRenameDetail)
          .onChange(async (value) => {
            this.plugin.settings.imageRenameDetail = value as ImageRenameDetail;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Remove empty folders after applying")
      .setDesc("Only folders that are empty after the move are removed.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.removeEmptyFolders).onChange(async (value) => {
          this.plugin.settings.removeEmptyFolders = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Remove visible OS metadata files during cleanup")
      .setDesc("Only removes visible metadata names such as Thumbs.db and desktop.ini. Dotfiles and hidden folders are always ignored.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.removeJunkFilesBeforeFolderCleanup).onChange(async (value) => {
          this.plugin.settings.removeJunkFilesBeforeFolderCleanup = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseExtensions(value: string): Set<string> {
  return new Set(parseCsv(value).map((extension) => extension.replace(/^\./, "").toLowerCase()));
}

function parseSourceFolders(value: string): string[] {
  return parseCsv(value)
    .map(cleanFolderPath)
    .filter(Boolean);
}

function parseSourceFileReferences(value: string): string[] {
  const rawItems = value
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const cleanedItems = rawItems
    .map((item) =>
      extractObsidianOpenFilePath(
        item
        .replace(/^!?\[\[/, "")
        .replace(/\]\]$/, "")
        .replace(/^!?\[[^\]]*]\(/, "")
        .replace(/\)$/, "")
        .split("|")[0]
        .split("#")[0]
        .trim()
        .replace(/^["']|["']$/g, "")
      )
    )
    .map((item) => normalizePath(item.replace(/^\/+/, "")))
    .filter(Boolean);

  return Array.from(new Set(cleanedItems));
}

function extractObsidianOpenFilePath(value: string): string {
  if (!value.startsWith("obsidian://")) {
    return value;
  }

  try {
    const url = new URL(value);
    const filePath = url.searchParams.get("file");
    return filePath || value;
  } catch {
    const match = value.match(/[?&]file=([^&]+)/);
    return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : value;
  }
}

function normalizeSettings(settings: VaultReorganizerSettings): VaultReorganizerSettings {
  const mediaExtensions = new Set([
    ...parseExtensions(settings.imageExtensions),
    ...parseExtensions(settings.videoExtensions),
    ...parseExtensions(settings.soundExtensions)
  ]);
  const attachmentExtensions = parseCsv(settings.attachmentExtensions)
    .map((extension) => extension.replace(/^\./, "").toLowerCase())
    .filter((extension) => extension && !mediaExtensions.has(extension));
  const handwritingExtensions = new Set(parseExtensions(settings.handwritingExtensions));
  handwritingExtensions.add("pdf");
  const handwritingSourceFolders = parseSourceFolders(settings.handwritingSourceFolder);
  if (
    handwritingSourceFolders.some((folder) => folder.toLowerCase() === settings.imagesFolder.toLowerCase()) &&
    !handwritingSourceFolders.some((folder) => folder.toLowerCase() === settings.attachmentsFolder.toLowerCase())
  ) {
    handwritingSourceFolders.push(cleanFolderPath(settings.attachmentsFolder));
  }

  return {
    ...settings,
    attachmentExtensions: Array.from(new Set(attachmentExtensions)).join(","),
    handwritingExtensions: Array.from(handwritingExtensions).join(","),
    handwritingMaxFiles:
      settings.handwritingMaxFiles === 10 ? DEFAULT_SETTINGS.handwritingMaxFiles : settings.handwritingMaxFiles,
    handwritingNotesFolder: getHandwritingNotesFolder(settings),
    handwritingSourceFolder: handwritingSourceFolders.join(","),
    splitOversizedHandwritingPdfs: settings.splitOversizedHandwritingPdfs !== false,
    handwritingPdfPageLimit: normalizePositiveInteger(
      settings.handwritingPdfPageLimit,
      DEFAULT_SETTINGS.handwritingPdfPageLimit
    )
  };
}

function normalizePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

function getImageRenameMimeType(extension: string): string | null {
  return IMAGE_RENAME_MIME_TYPES[extension.toLowerCase()] ?? null;
}

function getHandwritingMimeType(extension: string): string | null {
  const normalizedExtension = extension.toLowerCase();
  if (normalizedExtension === "pdf") {
    return "application/pdf";
  }

  return getImageRenameMimeType(normalizedExtension);
}

function hasHumanReadableImageName(file: TFile): boolean {
  const stem = fileStem(file.name);
  const normalized = stem
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return false;
  }

  if (looksLikeGeneratedImageName(stem, normalized)) {
    return false;
  }

  const words = normalized.match(/[a-z][a-z]+/g) ?? [];
  const meaningfulWords = words.filter((word) => !GENERIC_IMAGE_NAME_WORDS.has(word));
  const digitCount = (normalized.match(/\d/g) ?? []).length;
  const letterCount = (normalized.match(/[a-z]/g) ?? []).length;

  return meaningfulWords.length >= 2 && letterCount >= 6 && digitCount <= letterCount;
}

const GENERIC_IMAGE_NAME_WORDS = new Set([
  "copy",
  "edited",
  "file",
  "final",
  "image",
  "img",
  "photo",
  "picture",
  "scan",
  "screenshot",
  "screen",
  "shot",
  "untitled"
]);

function looksLikeGeneratedImageName(stem: string, normalized: string): boolean {
  const compact = stem.replace(/[\s_-]+/g, "").toLowerCase();

  if (/^[a-f0-9]{12,}$/i.test(compact) || /^[0-9]{8,}$/.test(compact)) {
    return true;
  }

  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(stem)) {
    return true;
  }

  return [
    /^img\s?\d+$/i,
    /^dscn?\s?\d+$/i,
    /^pxl\s?\d+/i,
    /^mvimg\s?\d+/i,
    /^pasted image/i,
    /^screen shot/i,
    /^screenshot/i,
    /^cleanshot/i,
    /^whatsapp image/i,
    /^image\s?\d*$/i,
    /^photo\s?\d*$/i,
    /^scan\s?\d*$/i,
    /^untitled\s?\d*$/i
  ].some((pattern) => pattern.test(normalized));
}

function fileStem(fileName: string): string {
  const extensionStart = fileName.lastIndexOf(".");
  return extensionStart > 0 ? fileName.substring(0, extensionStart) : fileName;
}

function sanitizeImageSubjectStem(subject: string): string {
  const withoutDiacritics = subject.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return withoutDiacritics
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase()
    .substring(0, 80)
    .replace(/-+$/g, "");
}

function buildOversizedHandwritingFileReason(file: TFile, canSplitPdf = false): string {
  const size = formatByteSize(file.stat.size);
  const limit = formatByteSize(MAX_HANDWRITING_FILE_BYTES);
  if (file.extension.toLowerCase() === "pdf") {
    if (canSplitPdf) {
      return `PDF is ${size}; add it to Specific handwriting files to render it into page images and create one combined Markdown note.`;
    }

    return `PDF is ${size}; direct handwriting conversion supports files up to ${limit}. Enable oversized PDF splitting, split it manually, compress it, or export it as smaller page images first.`;
  }

  return `File is ${size}; direct handwriting conversion supports files up to ${limit}.`;
}

async function loadPdfJsRuntime(): Promise<PdfJsRuntime> {
  const globalWithWorker = activeWindow as Window & PdfJsWorkerGlobal;
  const previousWorker = globalWithWorker.pdfjsWorker;
  const [pdfJs, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.mjs")
  ]);

  globalWithWorker.pdfjsWorker = {
    WorkerMessageHandler: worker.WorkerMessageHandler,
    __vaultReorganizerPdfJs: true
  };

  return {
    getDocument: pdfJs.getDocument,
    VerbosityLevel: pdfJs.VerbosityLevel,
    restoreWorkerGlobal: () => {
      if (previousWorker) {
        globalWithWorker.pdfjsWorker = previousWorker;
        return;
      }

      if (globalWithWorker.pdfjsWorker?.__vaultReorganizerPdfJs) {
        delete globalWithWorker.pdfjsWorker;
      }
    }
  };
}

async function renderPdfPageForHandwriting(
  page: PdfPageForRendering,
  pageNumber: number,
  detail: ImageRenameDetail
): Promise<RenderedPdfPageImage> {
  let scale = getPdfPageRenderScale(detail);
  let lastSize = 0;

  while (scale >= PDF_PAGE_RENDER_MIN_SCALE) {
    const rendered = await renderPdfPageAtScale(page, pageNumber, scale);
    if (rendered.bytes <= MAX_HANDWRITING_FILE_BYTES) {
      return rendered;
    }

    lastSize = rendered.bytes;
    scale *= 0.78;
  }

  throw new Error(
    `PDF page ${pageNumber} rendered to ${formatByteSize(lastSize)}, which is still over the ${formatByteSize(MAX_HANDWRITING_FILE_BYTES)} page image limit.`
  );
}

async function renderPdfPageAtScale(
  page: PdfPageForRendering,
  pageNumber: number,
  scale: number
): Promise<RenderedPdfPageImage> {
  const viewport = page.getViewport({ scale });
  const canvas = activeDocument.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  try {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create a PDF page canvas.");
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport, background: "rgb(255,255,255)" }).promise;

    let quality = PDF_PAGE_JPEG_START_QUALITY;
    let imageUrl = canvas.toDataURL("image/jpeg", quality);
    let bytes = estimateDataUrlBytes(imageUrl);

    while (bytes > MAX_HANDWRITING_FILE_BYTES && quality > PDF_PAGE_JPEG_MIN_QUALITY) {
      quality = Math.max(PDF_PAGE_JPEG_MIN_QUALITY, quality - PDF_PAGE_JPEG_QUALITY_STEP);
      imageUrl = canvas.toDataURL("image/jpeg", quality);
      bytes = estimateDataUrlBytes(imageUrl);
    }

    return {
      pageNumber,
      imageUrl,
      width: canvas.width,
      height: canvas.height,
      bytes
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function getPdfPageRenderScale(detail: ImageRenameDetail): number {
  if (detail === "low") {
    return 1.6;
  }

  if (detail === "auto") {
    return 2.0;
  }

  return 2.4;
}

function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  const base64Length = commaIndex >= 0 ? dataUrl.length - commaIndex - 1 : dataUrl.length;
  return Math.floor((base64Length * 3) / 4);
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown size";
  }

  const units = ["bytes", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`;
  }

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseImageSubjectFromResponse(response: unknown): string | null {
  const outputText = extractOpenAIOutputText(response);
  if (!outputText) {
    return null;
  }

  const trimmed = outputText.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const parsed = safeParseJson(jsonMatch[0]);
    if (isRecord(parsed) && typeof parsed.subject === "string") {
      return parsed.subject;
    }
  }

  return trimmed.replace(/^["'`]+|["'`]+$/g, "");
}

function parseHandwritingExtraction(response: unknown): HandwritingExtraction {
  const outputText = extractOpenAIOutputText(response);
  if (!outputText) {
    return { isHandwrittenNote: false, title: "", markdown: "" };
  }

  const trimmed = outputText.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? safeParseJson(jsonMatch[0]) : safeParseJson(trimmed);
  if (!isRecord(parsed)) {
    return { isHandwrittenNote: true, title: "Handwritten note", markdown: trimmed };
  }

  const isHandwrittenNote =
    readBooleanLike(parsed.is_handwritten_note) ?? readBooleanLike(parsed.isHandwrittenNote) ?? true;
  const title = typeof parsed.title === "string" ? parsed.title : "Handwritten note";
  const markdown = typeof parsed.markdown === "string" ? parsed.markdown : "";

  return {
    isHandwrittenNote,
    title,
    markdown
  };
}

function buildHandwritingPrompt(forceHandwriting: boolean, isPdf: boolean): string {
  const sourceDescription = isPdf
    ? "This file may be a PDF exported from OneNote or an iPad note app with Apple Pencil handwriting/ink."
    : "This image may contain handwriting from a notebook, tablet, or stylus.";
  const markdownInstructions =
    "Produce clean Obsidian Markdown. Preserve headings, bullets, numbered lists, checkboxes, dates, and line breaks where useful. " +
    "Use [illegible] for unclear words and do not invent missing text. Keep diagrams as short bracketed descriptions.";

  if (forceHandwriting) {
    return (
      `${sourceDescription} The user explicitly selected this file as a handwritten note source. ` +
      "Transcribe the handwritten content even if the file looks like a digital PDF, ink annotation layer, or exported notebook page. " +
      "Return only JSON with keys is_handwritten_note, title, and markdown. Set is_handwritten_note to true if any handwritten note content is present. " +
      `${markdownInstructions}`
    );
  }

  return (
    `${sourceDescription} Transcribe this file only if it contains a handwritten note. ` +
    "Return only JSON with keys is_handwritten_note, title, and markdown. " +
    "If it is not a handwritten note, return {\"is_handwritten_note\":false,\"title\":\"\",\"markdown\":\"\"}. " +
    `For handwritten notes, ${markdownInstructions}`
  );
}

function buildSplitPdfHandwritingPrompt(forceHandwriting: boolean, fileName: string, pageCount: number): string {
  const markdownInstructions =
    "Produce clean Obsidian Markdown. Preserve headings, bullets, numbered lists, checkboxes, dates, and line breaks where useful. " +
    "Use [illegible] for unclear words and do not invent missing text. Keep diagrams as short bracketed descriptions.";
  const detectionInstruction = forceHandwriting
    ? "The user explicitly selected this PDF as a handwritten note source, so transcribe the handwritten content even if the pages look like a digital PDF, ink annotation layer, or exported notebook."
    : "If the page images do not contain a handwritten note, return {\"is_handwritten_note\":false,\"title\":\"\",\"markdown\":\"\"}.";

  return (
    `The PDF "${fileName}" was too large for direct upload, so it has been rendered as ${pageCount} page image${pageCount === 1 ? "" : "s"} in order. ` +
    "Treat these page images as one PDF and create one combined Obsidian Markdown note. Preserve the page order. Do not create separate notes. " +
    "Add page headings only when they make the transcription clearer. " +
    `${detectionInstruction} Return only JSON with keys is_handwritten_note, title, and markdown. ` +
    `For handwritten notes, ${markdownInstructions}`
  );
}

function readBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return null;
}

function sanitizeMarkdownTitle(title: string): string {
  const withoutDiacritics = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const cleaned = withoutDiacritics
    .replace(/[#^[\]|]/g, " ")
    .replace(/[\\/:*?"<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.substring(0, 80).trim() || "Handwritten note";
}

function getHandwritingSourceLabel(file: TFile): string {
  return file.extension.toLowerCase() === "pdf" ? "Source PDF" : "Source image";
}

function formatHandwritingNoteMarkdown(title: string, sourcePath: string, markdown: string, sourceLabel: string): string {
  const trimmedMarkdown = markdown.trim();
  const body = trimmedMarkdown.startsWith("#") ? trimmedMarkdown : `# ${title}\n\n${trimmedMarkdown}`;
  return `${body}\n\n---\n\n${sourceLabel}: [[${sourcePath}]]\n`;
}

function markdownExcerpt(markdown: string): string {
  const normalized = markdown.replace(/\s+/g, " ").trim();
  if (normalized.length <= 160) {
    return normalized;
  }

  return `${normalized.substring(0, 157)}...`;
}

function extractOpenAIOutputText(response: unknown): string {
  if (isRecord(response) && typeof response.output_text === "string") {
    return response.output_text;
  }

  if (!isRecord(response) || !Array.isArray(response.output)) {
    return "";
  }

  const parts: string[] = [];
  for (const outputItem of response.output) {
    if (!isRecord(outputItem) || !Array.isArray(outputItem.content)) {
      continue;
    }

    for (const contentItem of outputItem.content) {
      if (isRecord(contentItem) && typeof contentItem.text === "string") {
        parts.push(contentItem.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function redactSecretLikeText(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]+/g, "sk-...");
}

function formatImageNamingError(error: unknown): string {
  const message = redactSecretLikeText(formatUnknownError(error)).trim();
  if (!message) {
    return "Unknown error";
  }

  return message.length > 120 ? `${message.substring(0, 117)}...` : message;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function cleanFolderPath(path: string): string {
  return normalizePath(path.trim().replace(/^\/+/, "").replace(/\/+$/, ""));
}

function getHandwritingNotesFolder(settings: VaultReorganizerSettings): string {
  return cleanFolderPath(settings.handwritingNotesFolder || DEFAULT_SETTINGS.handwritingNotesFolder);
}

function joinPath(folder: string, fileName: string): string {
  const cleanFolder = cleanFolderPath(folder);
  return cleanFolder ? normalizePath(`${cleanFolder}/${fileName}`) : normalizePath(fileName);
}

function parentPath(path: string): string {
  const normalizedPath = normalizePath(path);
  const slashIndex = normalizedPath.lastIndexOf("/");
  return slashIndex === -1 ? "" : normalizedPath.substring(0, slashIndex);
}

function baseName(path: string): string {
  const normalizedPath = normalizePath(path);
  const slashIndex = normalizedPath.lastIndexOf("/");
  return slashIndex === -1 ? normalizedPath : normalizedPath.substring(slashIndex + 1);
}

function pathDepth(path: string): number {
  const cleanPath = cleanFolderPath(path);
  return cleanPath ? cleanPath.split("/").length : 0;
}

function isHiddenPath(path: string): boolean {
  return cleanFolderPath(path)
    .split("/")
    .some((part) => part.startsWith("."));
}

function findHiddenBlockers(files: string[], folders: string[]): string[] {
  return [...files, ...folders].filter((path) => baseName(path).startsWith("."));
}

function countHiddenBlockers(remainingFolders: RemainingFolder[]): number {
  return remainingFolders.reduce((count, folder) => count + folder.hiddenPaths.length, 0);
}

function formatRemainingFolderReason(remaining: RemainingFolder): string {
  const base = `${remaining.files} files, ${remaining.folders} folders remain`;
  if (remaining.hiddenPaths.length === 0) {
    return base;
  }

  const shown = remaining.hiddenPaths.slice(0, 3).join(", ");
  const extra = remaining.hiddenPaths.length > 3 ? `, +${remaining.hiddenPaths.length - 3} more hidden` : "";
  return `${base}; hidden: ${shown}${extra}`;
}

function folderPathForFileStem(path: string): string | null {
  const folder = parentPath(path);
  const name = baseName(path);
  const extensionStart = name.lastIndexOf(".");
  if (extensionStart <= 0) {
    return null;
  }

  return joinPath(folder, name.substring(0, extensionStart));
}

function pathStartsWithFolder(path: string, folder: string): boolean {
  const normalizedPath = normalizePath(path).toLowerCase();
  const normalizedFolder = cleanFolderPath(folder).toLowerCase();
  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
}

function isFolderAlreadyExistsError(error: unknown): boolean {
  return formatUnknownError(error).toLowerCase().includes("folder already exists");
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getPlanItemCount(plan: ActivePlan): number {
  return plan.kind === "handwriting" ? plan.notes.length : plan.moves.length;
}

function formatApplyResultSummary(result: ApplyResult): string {
  if (result.planKind === "handwriting") {
    return `${result.planLabel}: created ${result.moved} Markdown notes. ${result.failed.length} notes failed. ${result.skipped.length} notes skipped during apply.`;
  }

  return (
    `${result.planLabel}: updated ${result.moved} files (${result.directRenamed} with direct rename fallback, ${result.copiedFallback} with copy/delete fallback). ` +
    `${result.failed.length} file updates failed. ` +
    `${result.skipped.length} files skipped during apply. Scanned ${result.cleanupScanned} folders, ` +
    `removed ${result.cleanupRemoved} empty folders, removed ${result.cleanupJunkRemoved} OS metadata files, ` +
    `and found ${countHiddenBlockers(result.cleanupRemaining)} hidden blockers.`
  );
}

function formatApplyNotice(result: ApplyResult): string {
  if (result.planKind === "handwriting") {
    return `Created ${result.moved} Markdown notes.`;
  }

  return `Vault Reorganizer updated ${result.moved} files.`;
}

function formatApplyReport(result: ApplyResult): string {
  const lines = [
    "Vault Reorganizer report",
    `Plan: ${result.planLabel}`,
    result.planKind === "handwriting" ? `Markdown notes created: ${result.moved}` : `File updates applied: ${result.moved}`,
    `Moved with direct rename fallback: ${result.directRenamed}`,
    `Moved with copy/delete fallback: ${result.copiedFallback}`,
    result.planKind === "handwriting" ? `Markdown note failures: ${result.failed.length}` : `File update failures: ${result.failed.length}`,
    result.planKind === "handwriting" ? `Markdown notes skipped during apply: ${result.skipped.length}` : `Files skipped during apply: ${result.skipped.length}`,
    `Folders scanned during cleanup: ${result.cleanupScanned}`,
    `Empty folders removed: ${result.cleanupRemoved}`,
    `OS metadata files removed during cleanup: ${result.cleanupJunkRemoved}`,
    `Folders still not empty: ${result.cleanupRemaining.length}`,
    `Hidden blockers found: ${countHiddenBlockers(result.cleanupRemaining)}`,
    `Folder cleanup skipped: ${result.cleanupSkipped.length}`,
    `Folder cleanup failures: ${result.cleanupFailed.length}`,
    ""
  ];

  if (result.failed.length > 0) {
    lines.push(result.planKind === "handwriting" ? "Failed Markdown notes:" : "Failed file updates:");
    for (const failure of result.failed) {
      lines.push(`- From: ${failure.source}`);
      lines.push(`  To: ${failure.target}`);
      lines.push(`  Error: ${failure.error}`);
    }
    lines.push("");
  }

  if (result.skipped.length > 0) {
    lines.push("Skipped during apply:");
    for (const skipped of result.skipped) {
      lines.push(`- ${skipped.path}: ${skipped.reason}`);
    }
    lines.push("");
  }

  if (result.cleanupSkipped.length > 0) {
    lines.push("Folder cleanup skipped:");
    for (const skipped of result.cleanupSkipped) {
      lines.push(`- ${skipped.path}: ${skipped.reason}`);
    }
    lines.push("");
  }

  if (result.cleanupRemaining.length > 0) {
    lines.push("Folders still not empty:");
    for (const remaining of result.cleanupRemaining) {
      lines.push(`- ${remaining.path}: ${remaining.files} files, ${remaining.folders} folders remain`);
      for (const hiddenPath of remaining.hiddenPaths) {
        lines.push(`  Hidden blocker: ${hiddenPath}`);
      }
    }
    lines.push("");
  }

  if (result.cleanupFailed.length > 0) {
    lines.push("Folder cleanup failures:");
    for (const failure of result.cleanupFailed) {
      lines.push(`- ${failure.path}: ${failure.error}`);
    }
  }

  return lines.join("\n");
}

function emptyApplyResultFromCleanup(cleanup: FolderCleanupResult): ApplyResult {
  return {
    planKind: "cleanup",
    planLabel: "Empty folder cleanup",
    moved: 0,
    directRenamed: 0,
    copiedFallback: 0,
    skipped: [],
    failed: [],
    cleanupRemoved: cleanup.removed,
    cleanupJunkRemoved: cleanup.junkRemoved,
    cleanupScanned: cleanup.scanned,
    cleanupSkipped: cleanup.skipped,
    cleanupFailed: cleanup.failed,
    cleanupRemaining: cleanup.remaining
  };
}

function formatCleanupNotice(cleanup: FolderCleanupResult): string {
  const base = `Removed ${cleanup.removed} empty folders and ${cleanup.junkRemoved} OS metadata files.`;
  const hiddenBlockers = countHiddenBlockers(cleanup.remaining);

  if (cleanup.failed.length > 0) {
    return `${base} ${cleanup.failed.length} cleanup errors.`;
  }

  if (hiddenBlockers > 0) {
    return `${base} ${hiddenBlockers} hidden blockers found.`;
  }

  if (cleanup.remaining.length > 0) {
    return `${base} ${cleanup.remaining.length} folders still not empty.`;
  }

  if (cleanup.skipped.length > 0) {
    return `${base} ${cleanup.skipped.length} skipped.`;
  }

  return base;
}

async function writeTextToClipboard(text: string): Promise<void> {
  const clipboard = activeWindow.navigator.clipboard;
  if (!clipboard?.writeText) {
    throw new Error("Clipboard API is not available.");
  }

  try {
    await clipboard.writeText(text);
  } catch (error) {
    throw error instanceof Error ? error : new Error("Clipboard copy was not permitted.");
  }
}

function formatReportTimestamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hour = padDatePart(date.getHours());
  const minute = padDatePart(date.getMinutes());
  const second = padDatePart(date.getSeconds());
  return `${year}-${month}-${day} ${hour}-${minute}-${second}`;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

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
  normalizePath
} from "obsidian";

type StrategyId = "five-folder" | "flat-root" | "attachments-only";

interface VaultReorganizerSettings {
  strategy: StrategyId;
  markdownFolder: string;
  attachmentsFolder: string;
  templatesFolder: string;
  canvasesFolder: string;
  basesFolder: string;
  otherFilesFolder: string;
  excludedFolders: string;
  templateFolders: string;
  attachmentExtensions: string;
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

interface ApplyResult {
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
  moves: PlannedMove[];
  skipped: SkippedFile[];
  warnings: string[];
  strategy: StrategyId;
}

const STRATEGY_LABELS: Record<StrategyId, string> = {
  "five-folder": "Six folder vault",
  "flat-root": "Markdown in root",
  "attachments-only": "Centralize attachments only"
};

const DEFAULT_SETTINGS: VaultReorganizerSettings = {
  strategy: "five-folder",
  markdownFolder: "Notes",
  attachmentsFolder: "Attachments",
  templatesFolder: "Templates",
  canvasesFolder: "Canvases",
  basesFolder: "Bases",
  otherFilesFolder: "Files",
  excludedFolders: ".obsidian,.trash,Archive",
  templateFolders: "Templates,Template",
  attachmentExtensions:
    "png,jpg,jpeg,gif,webp,svg,avif,bmp,heic,pdf,mp3,mp4,wav,m4a,mov,webm,doc,docx,xls,xlsx,ppt,pptx,zip",
  removeEmptyFolders: false,
  removeJunkFilesBeforeFolderCleanup: false
};

const REPORTS_FOLDER = "Vault Reorganizer Reports";
const MAX_PREVIEW_ROWS = 300;
const MAX_FAILURE_ROWS = 100;
const CLEANUP_JUNK_FILE_NAMES = new Set(["thumbs.db", "desktop.ini"]);

export default class VaultReorganizerPlugin extends Plugin {
  settings: VaultReorganizerSettings;
  lastPlan: ReorganizationPlan | null = null;

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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

    return { moves, skipped, warnings, strategy };
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
          error
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
      await this.app.vault.delete(currentFile, false);
      return;
    }

    await this.app.vault.adapter.remove(file.path);
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

  isExcluded(path: string): boolean {
    if (isHiddenPath(path)) {
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
          error
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
        await this.app.vault.adapter.remove(filePath);
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
      await this.app.vault.delete(folder, false);
      return;
    }

    await this.app.vault.adapter.rmdir(folderPath, false);
  }

  async collectFolderPaths(folderPath: string, result: FolderCleanupResult): Promise<string[]> {
    let listed;
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

class ReorganizerModal extends Modal {
  plugin: VaultReorganizerPlugin;
  strategy: StrategyId;
  plan: ReorganizationPlan | null = null;
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

    this.contentEl.createEl("h2", { text: "Vault reorganization planner" });

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

  renderEmptyPreview(): void {
    if (
      !this.summaryEl ||
      !this.previewEl ||
      !this.applyButton ||
      !this.cleanupButton ||
      !this.copyReportButton ||
      !this.createReportButton
    ) {
      return;
    }

    this.applyButton.setDisabled(true);
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

    this.summaryEl.empty();
    const strategyName = STRATEGY_LABELS[this.plan.strategy];
    this.summaryEl.createEl("p", {
      text: `${strategyName}: ${this.plan.moves.length} moves planned, ${this.plan.skipped.length} files skipped.`
    });

    for (const warning of this.plan.warnings) {
      this.summaryEl.createEl("p", { text: warning, cls: "vault-reorganizer-warning" });
    }

    this.previewEl.empty();

    if (this.plan.moves.length === 0) {
      this.previewEl.createEl("p", { text: "No moves are needed for this strategy." });
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

    this.applyButton.setDisabled(false);
    this.cleanupButton.setDisabled(false);
    this.copyReportButton.setDisabled(!this.lastResult);
    this.createReportButton.setDisabled(!this.lastResult);
  }

  async applyPreviewedMoves(): Promise<void> {
    if (!this.plan || this.plan.moves.length === 0) {
      return;
    }

    const confirmed = window.confirm(
      `Move ${this.plan.moves.length} files now? Make sure the vault is backed up before continuing.`
    );
    if (!confirmed) {
      return;
    }

    this.applyButton.setDisabled(true);
    this.cleanupButton.setDisabled(true);
    this.copyReportButton.setDisabled(true);
    this.createReportButton.setDisabled(true);
    this.summaryEl.setText("Applying moves...");

    try {
      this.lastResult = await this.plugin.applyPlan(this.plan);
      this.renderApplyResult(this.lastResult);
      this.cleanupButton.setDisabled(false);
      this.copyReportButton.setDisabled(false);
      this.createReportButton.setDisabled(false);
      new Notice(`Vault Reorganizer moved ${this.lastResult.moved} files.`);
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
      this.applyButton.setDisabled(!this.plan || this.plan.moves.length === 0);
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
      text:
        `Moved ${result.moved} files (${result.directRenamed} with direct rename fallback, ${result.copiedFallback} with copy/delete fallback). ` +
        `${result.failed.length} moves failed. ` +
        `${result.skipped.length} files skipped during apply. Scanned ${result.cleanupScanned} folders, ` +
        `removed ${result.cleanupRemoved} empty folders, removed ${result.cleanupJunkRemoved} OS metadata files, ` +
        `and found ${countHiddenBlockers(result.cleanupRemaining)} hidden blockers.`
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
      this.previewEl.createEl("p", { text: "All previewed moves completed." });
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
      row.createEl("td", { text: "Move failed" });
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
      row.createEl("td", { text: "File skipped" });
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

    containerEl.createEl("h2", { text: "Vault Reorganizer" });

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
          .setPlaceholder(".obsidian,.trash,Archive")
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

function cleanFolderPath(path: string): string {
  return normalizePath(path.trim().replace(/^\/+/, "").replace(/\/+$/, ""));
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

function formatApplyReport(result: ApplyResult): string {
  const lines = [
    "Vault Reorganizer report",
    `Moved: ${result.moved}`,
    `Moved with direct rename fallback: ${result.directRenamed}`,
    `Moved with copy/delete fallback: ${result.copiedFallback}`,
    `Move failures: ${result.failed.length}`,
    `Files skipped during apply: ${result.skipped.length}`,
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
    lines.push("Failed moves:");
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
  let clipboardError: unknown = null;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  document.body.appendChild(textArea);

  try {
    textArea.focus();
    textArea.select();
    const copied = document.execCommand("copy");
    if (!copied) {
      throw clipboardError instanceof Error ? clipboardError : new Error("Clipboard copy was not permitted.");
    }
  } finally {
    textArea.remove();
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

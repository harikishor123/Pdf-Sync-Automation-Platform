import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { BrowserContext, Download, Locator, Page } from "playwright";

export interface DownloadedPdf {
  filePath: string;
  pdfName: string;
  sourceFilename: string;  // original WhatsApp filename (UUID per send)
  skipped?: boolean;       // true = pre-identified as known, download was not needed
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(private readonly configService: ConfigService) {}

  // ─────────────────────────────────────────────
  // Public entry point
  // ─────────────────────────────────────────────
  //
  // AsyncGenerator: yields one DownloadedPdf at a time, newest-first.
  // The consumer (pdf-sync.service.ts) breaks as soon as it detects
  // a duplicate hash, which closes the generator and triggers the finally
  // block — so the browser always shuts down cleanly.

  async *streamPdfsNewestFirst(
    preCheck?: (filename: string) => Promise<boolean>,
  ): AsyncGenerator<DownloadedPdf> {
    this.logger.log("[PDF Sync] Starting");

    const groupName = this.configService.get<string>("PDF_SYNC_WHATSAPP_GROUP");
    if (!groupName) {
      this.logger.warn("[PDF Sync] PDF_SYNC_WHATSAPP_GROUP not set. Skipping.");
      return;
    }

    const debug = this.isDebugEnabled();
    const { chromium } = await import("playwright");

    const sessionDir = this.ensureDir(
      this.configService.get<string>("PDF_SYNC_WHATSAPP_SESSION_DIR") ??
        join(process.cwd(), ".runtime", "pdf-sync", "whatsapp-session"),
    );
    const downloadDir = this.ensureDir(
      this.configService.get<string>("PDF_SYNC_DOWNLOAD_DIR") ??
        join(process.cwd(), ".runtime", "pdf-sync", "downloads"),
    );
    const headless =
      this.configService.get<string>("PDF_SYNC_HEADLESS") === "true";

    const context = await chromium.launchPersistentContext(sessionDir, {
      acceptDownloads: true,
      headless,
      downloadsPath: downloadDir,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    });

    // Hide the Playwright/Chromium automation fingerprint so WhatsApp Web
    // does not detect headless mode and force a QR re-scan.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(30000);

      await page.goto("https://web.whatsapp.com", {
        waitUntil: "domcontentloaded",
      });

      // ── Step 1: Confirm session is authenticated ──────────────────────
      const loginState = await this.waitForLoginState(page);
      if (loginState !== "logged-in") {
        throw new Error(
          "WhatsApp session is not authenticated. " +
            "Set PDF_SYNC_HEADLESS=false and scan the QR code first.",
        );
      }

      // ── Step 2: Open the target group chat ─────────────────────────────
      await this.openGroupChat(page, groupName);
      this.logger.log("[PDF Sync] Group opened");

      // ── Step 3: Scan PDFs newest → oldest, yield each before moving on ─
      const debugDir = debug
        ? this.ensureDir(
            this.configService.get<string>("PDF_SYNC_DEBUG_DIR") ??
              join(process.cwd(), ".runtime", "pdf-sync", "debug"),
          )
        : null;

      // Scroll up so that PDFs buried under recent text messages are rendered
      // into the DOM before we count them. WhatsApp Web is virtualized — only
      // messages near the current scroll position exist in the DOM at all.
      await this.scrollUpToRevealPDFs(page);

      if (debug && debugDir) {
        await this.debugScreenshot(page, debugDir, "whatsapp-chat-view.png");
        await this.debugDumpCandidates(page);
      }

      const pdfCount = await page
        .locator('div[data-testid="document-thumb"]')
        .count();

      if (pdfCount === 0) {
        this.logger.warn(
          "[PDF Sync] No PDFs found in chat view." +
            (debug && debugDir
              ? ` See debug screenshots in ${debugDir}`
              : " Enable PDF_SYNC_DEBUG=true for diagnostics."),
        );
        return;
      }

      this.logger.log(
        `[PDF Sync] Found ${pdfCount} PDF card(s). Scanning newest → oldest.`,
      );

      // WhatsApp renders oldest at top, newest at bottom.
      // Counting down from the last index processes newest-first,
      // so the consumer can stop the moment it sees a known hash.
      for (let i = pdfCount - 1; i >= 0; i--) {
        const cardNumber = pdfCount - i;
        this.logger.log(
          `[PDF Sync] Card ${cardNumber}/${pdfCount} (DOM index ${i}).`,
        );

        const pdfCard = page
          .locator('div[data-testid="document-thumb"]')
          .nth(i);
        await pdfCard.scrollIntoViewIfNeeded().catch(() => undefined);
        await page.waitForTimeout(500);

        // Read the WhatsApp filename from the card DOM before downloading.
        // If the caller already has this filename in DB, skip the download entirely.
        const sourceFilename = await this.readCardFilename(pdfCard);
        if (sourceFilename && preCheck && (await preCheck(sourceFilename))) {
          this.logger.log(
            `[PDF Sync] Card ${cardNumber}/${pdfCount}: known filename "${sourceFilename}" — skipping download.`,
          );
          yield { filePath: "", pdfName: sourceFilename, sourceFilename, skipped: true };
          continue; // no overlay to dismiss — card was never clicked
        }

        const download = await this.downloadOnePdfCard(
          page,
          context,
          pdfCard,
          i,
          debug,
          debugDir,
        );

        if (download) {
          const suggested = download.suggestedFilename();
          const fileName = this.uniqueFileName(downloadDir, suggested);
          const filePath = join(downloadDir, fileName);
          await download.saveAs(filePath);
          this.logger.log(`[PDF Sync] Downloaded: ${fileName}`);
          yield { filePath, pdfName: fileName, sourceFilename: sourceFilename ?? suggested };
        } else {
          this.logger.warn(
            `[PDF Sync] Card ${cardNumber}/${pdfCount} had no downloadable file; skipping.`,
          );
        }

        // Dismiss the preview overlay before moving to the next card.
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[PDF Sync] Fatal error: ${msg}`);
      throw err;
    } finally {
      // Runs on normal completion and also when the consumer breaks early.
      await context.close();
    }
  }

  // ─────────────────────────────────────────────
  // Step 1 — Wait for login or QR
  // ─────────────────────────────────────────────

  private async waitForLoginState(page: Page): Promise<"logged-in" | "qr"> {
    const qr = 'canvas[aria-label*="Scan me"]';
    const chatList = 'div[data-testid="chat-list"]';

    try {
      await page.waitForSelector(`${qr}, ${chatList}`, { timeout: 60000 });
    } catch {
      return "qr";
    }

    const isQr = await page
      .locator(qr)
      .isVisible()
      .catch(() => false);
    return isQr ? "qr" : "logged-in";
  }

  // ─────────────────────────────────────────────
  // Step 2 — Open the group chat by name
  // ─────────────────────────────────────────────

  private async openGroupChat(page: Page, groupName: string): Promise<void> {
    await page.waitForSelector('div[data-testid="chat-list"]', {
      timeout: 30000,
    });

    const searchBoxSelector = [
      'input[aria-label="Search or start a new chat"]',
      'input[type="text"][data-tab="3"]',
      'div[data-testid="chat-list-search-container"] input',
    ].join(", ");

    const searchBox = page.locator(searchBoxSelector).first();
    await searchBox.waitFor({ state: "visible", timeout: 15000 });
    await searchBox.click();
    await searchBox.fill(groupName);

    const searchResultItem =
      'div[aria-label="Search results."] div[role="row"]';

    try {
      await page.waitForSelector(searchResultItem, { timeout: 10000 });
    } catch {
      throw new Error(
        `[PDF Sync] No search results appeared for "${groupName}". ` +
          "Check that PDF_SYNC_WHATSAPP_GROUP matches the exact group name in WhatsApp.",
      );
    }

    const matchingResult = page
      .locator(`div[aria-label="Search results."] span[title="${groupName}"]`)
      .first();

    if ((await matchingResult.count()) === 0) {
      throw new Error(
        `[PDF Sync] Group "${groupName}" not found in search results. ` +
          "Verify the group name in PDF_SYNC_WHATSAPP_GROUP.",
      );
    }

    await matchingResult.click();

    const chatHeaderSelector = 'header div[role="button"] span[title]';
    await page.waitForSelector(chatHeaderSelector, { timeout: 15000 });

    // Give the message list a moment to render before scanning for PDFs.
    await page.waitForTimeout(2000);
  }

  // ─────────────────────────────────────────────
  // Read the WhatsApp filename from a card's DOM without downloading
  // ─────────────────────────────────────────────

  private async readCardFilename(pdfCard: Locator): Promise<string | null> {
    try {
      return await pdfCard.evaluate((el: Element) => {
        const container =
          el.closest('[role="row"]') ??
          el.closest('[data-testid*="msg"]') ??
          el.parentElement?.parentElement?.parentElement;
        if (!container) return null;

        // Prefer a span with a title attribute ending in .pdf
        const titled = container.querySelector<HTMLElement>('span[title]');
        if (titled?.title?.toLowerCase().endsWith('.pdf')) return titled.title;

        // Fall back to any span whose visible text looks like a filename
        const spans = Array.from(container.querySelectorAll('span'));
        const match = spans.find((s) =>
          s.textContent?.trim().toLowerCase().endsWith('.pdf'),
        );
        return match?.textContent?.trim() ?? null;
      });
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // Scroll up to reveal PDFs buried under recent text messages
  // ─────────────────────────────────────────────

  private async scrollUpToRevealPDFs(page: Page): Promise<void> {
    // Fast path: PDFs already visible — no scrolling needed.
    const initial = await page
      .locator('div[data-testid="document-thumb"]')
      .count();
    if (initial > 0) {
      this.logger.log(
        `[PDF Sync] ${initial} PDF card(s) already visible — no scroll needed.`,
      );
      return;
    }

    // Find the scrollable message container.
    const containerSelectors = [
      'div[data-testid="msg-container"]',
      '#main div[tabindex="-1"]',
      '#main .copyable-area',
    ];
    let container = null;
    for (const sel of containerSelectors) {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        container = el;
        break;
      }
    }

    if (!container) {
      this.logger.warn(
        "[PDF Sync] Could not find scroll container — PDFs may be missed if buried under text messages.",
      );
      return;
    }

    // Scroll up one step at a time and stop the moment a PDF card appears.
    // Each step covers ~1500 px; 10 steps = ~15 000 px of history.
    for (let step = 1; step <= 10; step++) {
      await container
        .evaluate((el: Element) => {
          (el as HTMLElement).scrollTop -= 1500;
        })
        .catch(() => undefined);
      await page.waitForTimeout(400);

      const count = await page
        .locator('div[data-testid="document-thumb"]')
        .count();
      if (count > 0) {
        this.logger.log(
          `[PDF Sync] Found ${count} PDF card(s) after ${step} scroll step(s).`,
        );
        return;
      }
    }

    this.logger.warn("[PDF Sync] No PDFs found after scrolling up 15 000 px.");
  }

  // ─────────────────────────────────────────────
  // Download one PDF card (overlay flow)
  // ─────────────────────────────────────────────

  private async downloadOnePdfCard(
    page: Page,
    context: BrowserContext,
    pdfCard: Locator,
    cardIndex: number,
    debug: boolean,
    debugDir: string | null,
  ): Promise<Download | null> {
    if (debug && debugDir) {
      await this.debugScreenshot(
        page,
        debugDir,
        `whatsapp-chat-view-pre-click-${cardIndex}.png`,
      );
    }

    const cardClickDownload = context
      .waitForEvent("download", { timeout: 5000 })
      .catch(() => null);
    await pdfCard.click();
    const directDownload = await cardClickDownload;

    if (directDownload) {
      return directDownload;
    }

    await page.waitForTimeout(1000);

    if (debug && debugDir) {
      await this.debugScreenshot(
        page,
        debugDir,
        `whatsapp-chat-view-preview-overlay-${cardIndex}.png`,
      );
      await this.debugDumpOverlayCandidates(page);
    }

    const downloadButtonSelectors = [
      '[aria-label="Download"]',
      '[data-testid="media-download-btn"]',
      '[data-testid="download-btn"]',
      '[data-icon="media-download"]',
      '[data-icon*="download" i]',
      'button[title="Download"]',
    ];

    for (const selector of downloadButtonSelectors) {
      const btn = page.locator(selector).first();
      const visible =
        (await btn.count().catch(() => 0)) > 0
          ? await btn.isVisible().catch(() => false)
          : false;

      if (visible) {
        const downloadPromise = context.waitForEvent("download", {
          timeout: 20000,
        });
        await btn.click();

        const download = await downloadPromise.catch(() => null);
        if (download) {
          return download;
        }
      }
    }

    this.logger.warn(
      `[PDF Sync] No download button matched in preview overlay for card ${cardIndex}.`,
    );

    if (debug && debugDir) {
      await this.debugScreenshot(
        page,
        debugDir,
        `whatsapp-chat-view-download-failed-${cardIndex}.png`,
      );
    }

    return null;
  }

  // ─────────────────────────────────────────────
  // Debug instrumentation (PDF_SYNC_DEBUG=true only)
  // ─────────────────────────────────────────────

  private isDebugEnabled(): boolean {
    return this.configService.get<string>("PDF_SYNC_DEBUG") === "true";
  }

  private async debugScreenshot(
    page: Page,
    debugDir: string,
    fileName: string,
  ): Promise<void> {
    try {
      const path = join(debugDir, fileName);
      await page.screenshot({ path, fullPage: false });
      this.logger.debug(`[PDF Sync][DEBUG] Screenshot saved: ${path}`);
    } catch (err) {
      this.logger.debug(
        `[PDF Sync][DEBUG] Failed to save screenshot "${fileName}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async debugDumpCandidates(page: Page): Promise<void> {
    const candidates: Record<string, string> = {
      'span[title*=".pdf" i]': 'span[title*=".pdf" i]',
      'div[data-testid*="document" i]': 'div[data-testid*="document" i]',
      '*[data-testid*="download" i]': '*[data-testid*="download" i]',
      'div[role="row"] (message rows)': 'div[role="row"]',
    };

    this.logger.debug("[PDF Sync][DEBUG] ── Candidate element dump ──");
    for (const [label, selector] of Object.entries(candidates)) {
      await this.debugLogLocator(page.locator(selector), label);
    }
    this.logger.debug("[PDF Sync][DEBUG] ── End candidate dump ──");
  }

  private async debugDumpOverlayCandidates(page: Page): Promise<void> {
    const candidates = [
      '[aria-label="Download"]',
      '[data-testid="media-download-btn"]',
      '[data-icon*="download" i]',
      'button[title="Download"]',
      '*[data-testid*="download" i]',
    ];

    this.logger.debug("[PDF Sync][DEBUG] ── Preview overlay candidate dump ──");
    for (const selector of candidates) {
      await this.debugLogLocator(page.locator(selector), selector);
    }
    this.logger.debug("[PDF Sync][DEBUG] ── End preview overlay dump ──");
  }

  private async debugLogLocator(
    locator: Locator,
    label: string,
  ): Promise<void> {
    try {
      const count = await locator.count();
      this.logger.debug(`[PDF Sync][DEBUG] "${label}" → count=${count}`);

      if (count > 0) {
        const limit = Math.min(count, 5);
        for (let i = 0; i < limit; i++) {
          const el = locator.nth(i);
          const text = await el.textContent().catch(() => null);
          const html = await el
            .evaluate((node) => node.outerHTML)
            .catch(() => null);
          this.logger.debug(
            `[PDF Sync][DEBUG]   [${i}] textContent="${(text ?? "").trim().slice(0, 120)}"`,
          );
          this.logger.debug(
            `[PDF Sync][DEBUG]   [${i}] outerHTML="${(html ?? "").slice(0, 400)}"`,
          );
        }
      }
    } catch (err) {
      this.logger.debug(
        `[PDF Sync][DEBUG] Selector "${label}" failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ─────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────

  private ensureDir(dir: string): string {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  private uniqueFileName(dir: string, suggested: string): string {
    if (!existsSync(join(dir, suggested))) return suggested;
    const dot = suggested.lastIndexOf(".");
    const base = dot === -1 ? suggested : suggested.slice(0, dot);
    const ext = dot === -1 ? "" : suggested.slice(dot);
    return `${base}-${Date.now()}${ext}`;
  }
}

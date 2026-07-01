import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { BrowserContext, Download, Locator, Page } from "playwright";

export interface DownloadedPdf {
  filePath: string;
  pdfName: string;
  caption?: string; // WhatsApp caption — contains line number e.g. "IN2511"
  whatsappReceivedAt?: Date; // WhatsApp message timestamp — used as sync checkpoint
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

  async *streamPdfs(
    checkpoint?: Date,
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

      // ── Step 3: Scan PDFs oldest → newest, start from checkpoint ──────────
      const debugDir = debug
        ? this.ensureDir(
            this.configService.get<string>("PDF_SYNC_DEBUG_DIR") ??
              join(process.cwd(), ".runtime", "pdf-sync", "debug"),
          )
        : null;

      // Scroll up until the oldest visible message is at or before the checkpoint.
      // No checkpoint = first sync, scroll up as far as possible.
      await this.scrollUpToCheckpoint(page, checkpoint);

      if (debug && debugDir) {
        await this.debugScreenshot(page, debugDir, "whatsapp-chat-view.png");
        await this.debugDumpCandidates(page);
      }

      const msgLocator = page.locator("div[data-testid^='conv-msg-']");
      let msgCount = await msgLocator.count();

      this.logger.log(
        `[PDF Sync] ${msgCount} message(s) visible. Scanning oldest → newest from checkpoint.`,
      );

      // WhatsApp renders oldest at top (index 0), newest at bottom (index msgCount-1).
      // Scan upward so we process in chronological order.
      // Skip messages before the checkpoint; process everything from checkpoint onward.
      // Refresh msgCount each iteration — scrolling down virtualizes in newer messages.
      let pdfSeen = 0;
      for (let i = 0; i < msgCount; i++) {
        const msgEl = msgLocator.nth(i);
        await msgEl.scrollIntoViewIfNeeded().catch(() => undefined);
        await page.waitForTimeout(300);

        // New messages may have been rendered at the bottom as we scroll down.
        const refreshed = await msgLocator.count();
        if (refreshed > msgCount) msgCount = refreshed;

        // Only handle messages that contain a PDF attachment.
        const docThumb = msgEl.locator('div[data-testid="document-thumb"]');
        if ((await docThumb.count()) === 0) continue;

        const whatsappReceivedAt = await this.readMsgTimestamp(msgEl);

        // Skip messages already covered by the previous sync run.
        if (checkpoint && whatsappReceivedAt && whatsappReceivedAt < checkpoint) {
          continue;
        }

        pdfSeen++;
        this.logger.log(`[PDF Sync] PDF message ${pdfSeen} (msg index ${i}).`);

        const caption = await this.readCardCaption(msgEl);
        const download = await this.downloadOnePdfCard(
          page,
          context,
          docThumb.first(),
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
          yield {
            filePath,
            pdfName: fileName,
            caption: caption ?? undefined,
            whatsappReceivedAt: whatsappReceivedAt ?? undefined,
          };
        } else {
          this.logger.warn(
            `[PDF Sync] PDF message ${pdfSeen} had no downloadable file; skipping.`,
          );
        }

        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
      }

      if (pdfSeen === 0) {
        this.logger.log("[PDF Sync] No new PDFs since last checkpoint.");
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
  // ─────────────────────────────────────────────
  // Read the caption text from a card's message bubble
  // ─────────────────────────────────────────────

  private async readCardCaption(pdfCard: Locator): Promise<string | null> {
    try {
      return await pdfCard.evaluate((el: Element) => {
        const container =
          el.closest('[role="row"]') ??
          el.closest('[data-testid*="msg"]') ??
          el.parentElement?.parentElement?.parentElement;
        if (!container) return null;

        // Caption text sits in a selectable-text span inside the same bubble.
        const textSpan = container.querySelector<HTMLElement>(
          'span.selectable-text, span[data-lexical-text="true"]',
        );
        const text = textSpan?.textContent?.trim() ?? null;
        return text && text.length > 0 ? text : null;
      });
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // DOM structure diagnostic — dumps one conv-msg-* subtree then returns null
  // ─────────────────────────────────────────────

  private async readMsgTimestamp(msgEl: Locator): Promise<Date | null> {
    try {
      const timeText = await msgEl.evaluate((el: Element): string | null => {
        // The visible time lives as a plain leaf span inside [data-testid="msg-meta"].
        // Example structure: <div data-testid="msg-meta"><span><span>[16:41]</span>…
        const meta = el.querySelector('[data-testid="msg-meta"]');
        if (!meta) return null;
        const TIME_RE = /^\d{1,2}:\d{2}$/;
        for (const span of Array.from(meta.querySelectorAll("span"))) {
          if (span.children.length > 0) continue;
          const text = (span.textContent ?? "").trim();
          if (TIME_RE.test(text)) return text;
        }
        return null;
      });

      if (!timeText) {
        this.logger.warn("[PDF Sync] msg-meta time not found");
        return null;
      }

      // Date comes from the WhatsApp date-divider element that precedes this
      // message in the DOM. Walk up through ancestor levels and check siblings
      // at each level — WhatsApp wraps messages in multiple positioned divs so
      // the list-level siblings (where dividers live) may be several hops up.
      const dateText = await msgEl.evaluate((el: Element): string | null => {
        const DATE_RE =
          /(\d{1,2}\s+\w+\s+\d{4}|today|yesterday|\d{1,2}\/\d{1,2}\/\d{4})/i;

        let anchor: Element | null = el;
        for (let depth = 0; depth < 8 && anchor; depth++) {
          let sibling = anchor.previousElementSibling;
          while (sibling) {
            const isMsg =
              sibling.hasAttribute("data-id") ||
              !!sibling.querySelector('[data-testid^="conv-msg-"]');
            if (!isMsg) {
              const text = (sibling.textContent ?? "").trim();
              if (text.length > 0 && text.length < 60) {
                const m = text.match(DATE_RE);
                if (m) return m[1];
              }
            }
            sibling = sibling.previousElementSibling;
          }
          anchor = anchor.parentElement;
        }
        return null;
      });

      this.logger.log(
        `[PDF Sync] Timestamp: time="${timeText}" dateDivider="${dateText ?? "none"}"`,
      );

      if (!dateText) {
        // Diagnostic: walk up ancestors and show siblings at each depth so we
        // can identify exactly where date-divider elements live in the DOM.
        const siblingInfo = await msgEl.evaluate((el: Element): string => {
          const parts: string[] = [];
          let anchor: Element | null = el;
          for (let depth = 0; depth < 8 && anchor; depth++) {
            let s = anchor.previousElementSibling;
            let n = 0;
            while (s && n < 2) {
              const text = (s.textContent ?? "").trim().slice(0, 30);
              const role = s.getAttribute("role") ?? "-";
              const tid = (s.getAttribute("data-testid") ?? "").slice(0, 15);
              parts.push(`d${depth}:<${s.tagName} r="${role}" t="${tid}"> "${text}"`);
              s = s.previousElementSibling;
              n++;
            }
            anchor = anchor.parentElement;
          }
          return parts.length ? parts.join(" | ") : "no-siblings-at-any-depth";
        });
        this.logger.warn(`[PDF Sync] No date divider; siblings by depth: ${siblingInfo}`);
      }

      const today = new Date();
      let year = today.getFullYear();
      let month = today.getMonth() + 1;
      let day = today.getDate();

      if (dateText) {
        const lower = dateText.toLowerCase();
        if (lower === "yesterday") {
          const y = new Date(today);
          y.setDate(y.getDate() - 1);
          year = y.getFullYear();
          month = y.getMonth() + 1;
          day = y.getDate();
        } else if (lower !== "today") {
          // "18 June 2026" format
          const m1 = dateText.match(
            /^(\d{1,2})\s+(\w+)\s+(\d{4})$/i,
          );
          if (m1) {
            const MONTHS: Record<string, number> = {
              january: 1, february: 2, march: 3, april: 4,
              may: 5, june: 6, july: 7, august: 8,
              september: 9, october: 10, november: 11, december: 12,
            };
            day = parseInt(m1[1], 10);
            month = MONTHS[m1[2].toLowerCase()] ?? month;
            year = parseInt(m1[3], 10);
          }
          // "DD/MM/YYYY" format
          const m2 = dateText.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if (m2) {
            day = parseInt(m2[1], 10);
            month = parseInt(m2[2], 10);
            year = parseInt(m2[3], 10);
          }
        }
      }

      // Construct as explicit IST datetime so the Date is correct on any server timezone.
      const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${timeText}:00+05:30`;
      const parsed = new Date(iso);
      return isNaN(parsed.getTime()) ? null : parsed;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // Scroll up to load messages at/before the checkpoint into the DOM
  // ─────────────────────────────────────────────

  private async scrollUpToCheckpoint(page: Page, checkpoint?: Date): Promise<void> {
    const containerSelectors = [
      'div[data-testid="msg-container"]',
      '#main div[tabindex="-1"]',
      "#main .copyable-area",
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
      this.logger.warn("[PDF Sync] Scroll container not found — older messages may be missing.");
      return;
    }

    // With a checkpoint: scroll up until the oldest visible message is older
    // than the checkpoint so we don't miss messages right at the boundary.
    // Without a checkpoint (first sync): scroll up 20 steps to load as much
    // history as possible (~30 000 px).
    const MAX_STEPS = 20;

    for (let step = 1; step <= MAX_STEPS; step++) {
      await container
        .evaluate((el: Element) => { (el as HTMLElement).scrollTop -= 1500; })
        .catch(() => undefined);
      await page.waitForTimeout(400);

      if (checkpoint) {
        const msgLocator = page.locator("div[data-testid^='conv-msg-']");
        const count = await msgLocator.count();
        if (count > 0) {
          const oldestTs = await this.readMsgTimestamp(msgLocator.nth(0));
          if (oldestTs && oldestTs <= checkpoint) {
            this.logger.log(`[PDF Sync] Reached checkpoint area after ${step} scroll step(s).`);
            return;
          }
        }
      }
    }

    const msgCount = await page.locator("div[data-testid^='conv-msg-']").count();
    this.logger.log(`[PDF Sync] Scrolled up ${MAX_STEPS} step(s); ${msgCount} message(s) visible.`);
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

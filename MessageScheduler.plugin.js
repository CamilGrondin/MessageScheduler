/**
 * @name MessageScheduler
 * @author camilgrondin
 * @description Schedule one or more messages after X minutes or at HH:MM.
 * @version 0.1.0
 */

module.exports = class MessageScheduler {
    constructor(meta = {}) {
        this.meta = meta;
        this.pluginName = meta.name || "MessageScheduler";
        this.api = new BdApi(this.pluginName);
        this.React = this.api.React;
        this.Patcher = this.api.Patcher;
        this.Webpack = this.api.Webpack;
        this.Data = this.api.Data;
        this.DOM = this.api.DOM;
        this.ContextMenu = this.api.ContextMenu;
        this.UI = this.api.UI;
        this.Logger = this.api.Logger;

        this.storageKey = "scheduled-messages";
        this.cssId = "message-scheduler-css";
        this.modalId = "message-scheduler-modal";
        this.menuItemId = "message-scheduler-menu-item";

        this.queue = [];
        this.timers = new Map();
        this.menuObserver = null;
        this.menuScanTimeout = null;
        this.activeChannelId = "";
        this.lastScheduleValue = "";
    }

    start() {
        this.queue = this.loadQueue();
        this.injectCSS();
        this.restoreTimers();
        this.observeAttachmentMenus();
        this.scanForAttachmentMenus();
    }

    stop() {
        this.disconnectAttachmentObserver();
        this.clearAttachmentMenuScan();
        this.removeInjectedAttachmentMenuItems();
        this.clearAllTimers();
        this.closeSchedulerModal(true);
        this.removeCSS();
    }

    getMountNode() {
        return document.getElementById("app-mount") || document.body || document.documentElement;
    }

    injectCSS() {
        const css = `
            #message-scheduler-modal {
                position: fixed;
                inset: 0;
                background: rgba(8, 10, 16, 0.72);
                backdrop-filter: blur(14px) saturate(140%);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1000;
            }
            #message-scheduler-modal .ms-modal-dialog {
                position: relative;
                width: 580px;
                max-width: calc(100vw - 32px);
                max-height: calc(100vh - 48px);
                overflow: hidden;
                background:
                    radial-gradient(circle at top right, rgba(88, 101, 242, 0.16), transparent 32%),
                    linear-gradient(180deg, rgba(35, 37, 43, 0.99), rgba(23, 24, 28, 0.99));
                color: var(--text-normal, #dbdee1);
                border-radius: 18px;
                border: 1px solid rgba(255, 255, 255, 0.08);
                box-shadow: 0 32px 96px rgba(0, 0, 0, 0.52);
                display: flex;
                flex-direction: column;
                font-family: var(--font-primary, sans-serif);
            }
            #message-scheduler-modal .ms-modal-dialog::before {
                content: "";
                position: absolute;
                inset: 0 auto auto 0;
                width: 100%;
                height: 4px;
                background: linear-gradient(90deg, #5865f2, #8b9cfb 54%, #c0c9ff);
            }
            #message-scheduler-modal .ms-modal-header {
                padding: 18px 20px 14px;
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 16px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
                background: rgba(255, 255, 255, 0.02);
            }
            #message-scheduler-modal .ms-modal-heading {
                display: flex;
                flex-direction: column;
                gap: 6px;
                min-width: 0;
            }
            #message-scheduler-modal .ms-modal-kicker {
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.14em;
                text-transform: uppercase;
                color: rgba(192, 201, 255, 0.86);
            }
            #message-scheduler-modal .ms-modal-title-row {
                display: flex;
                align-items: center;
                gap: 10px;
                min-width: 0;
                flex-wrap: wrap;
            }
            #message-scheduler-modal .ms-modal-title {
                font-size: 18px;
                font-weight: 700;
                line-height: 1.15;
                letter-spacing: -0.02em;
            }
            #message-scheduler-modal .ms-modal-subtitle {
                font-size: 13px;
                line-height: 1.45;
                color: var(--text-muted, #949ba4);
                max-width: 44ch;
            }
            #message-scheduler-modal .ms-modal-chip {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                min-height: 24px;
                padding: 0 10px;
                border-radius: 999px;
                background: rgba(88, 101, 242, 0.16);
                border: 1px solid rgba(88, 101, 242, 0.22);
                color: #cfd7ff;
                font-size: 12px;
                font-weight: 600;
                max-width: 100%;
            }
            #message-scheduler-modal .ms-modal-close {
                border: none;
                background: rgba(255, 255, 255, 0.04);
                color: var(--text-muted, #949ba4);
                font-size: 18px;
                cursor: pointer;
                padding: 6px 10px;
                border-radius: 10px;
                transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease;
            }
            #message-scheduler-modal .ms-modal-close:hover {
                color: var(--text-normal, #dbdee1);
                background: rgba(255, 255, 255, 0.08);
                transform: translateY(-1px);
            }
            #message-scheduler-modal .ms-modal-body {
                padding: 18px 20px 16px;
                overflow: auto;
                display: flex;
                flex-direction: column;
                gap: 12px;
                background: linear-gradient(180deg, rgba(255, 255, 255, 0.01), transparent);
            }
            #message-scheduler-modal .ms-section {
                padding: 14px;
                border-radius: 14px;
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(255, 255, 255, 0.06);
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            #message-scheduler-modal .ms-section-header {
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: 12px;
            }
            #message-scheduler-modal .ms-section-title {
                font-size: 12px;
                font-weight: 700;
                color: #dfe4ff;
                text-transform: uppercase;
                letter-spacing: 0.08em;
            }
            #message-scheduler-modal .ms-section-hint {
                font-size: 12px;
                color: var(--text-muted, #949ba4);
            }
            #message-scheduler-modal .ms-input,
            #message-scheduler-modal .ms-textarea {
                width: 100%;
                background: rgba(0, 0, 0, 0.18);
                border: 1px solid rgba(255, 255, 255, 0.08);
                color: var(--text-normal, #dbdee1);
                border-radius: 12px;
                padding: 12px 14px;
                font-size: 14px;
                outline: none;
                transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
            }
            #message-scheduler-modal .ms-input:focus,
            #message-scheduler-modal .ms-textarea:focus {
                border-color: rgba(88, 101, 242, 0.6);
                box-shadow: 0 0 0 3px rgba(88, 101, 242, 0.16);
                background: rgba(0, 0, 0, 0.24);
            }
            #message-scheduler-modal .ms-textarea {
                min-height: 140px;
                resize: vertical;
                line-height: 1.45;
            }
            #message-scheduler-modal .ms-help {
                font-size: 12px;
                color: var(--text-muted, #949ba4);
            }
            #message-scheduler-modal .ms-modal-footer {
                padding: 14px 20px 18px;
                display: flex;
                justify-content: flex-end;
                gap: 8px;
                border-top: 1px solid rgba(255, 255, 255, 0.06);
                background: rgba(255, 255, 255, 0.02);
            }
            #message-scheduler-modal .ms-btn {
                border: none;
                border-radius: 12px;
                padding: 10px 16px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
            }
            #message-scheduler-modal .ms-btn-secondary {
                background: rgba(255, 255, 255, 0.08);
                color: var(--text-normal, #dbdee1);
            }
            #message-scheduler-modal .ms-btn-secondary:hover {
                background: rgba(255, 255, 255, 0.12);
                transform: translateY(-1px);
            }
            #message-scheduler-modal .ms-btn-primary {
                background: linear-gradient(135deg, #5865f2, #7f8cff);
                color: #ffffff;
                box-shadow: 0 10px 22px rgba(88, 101, 242, 0.24);
            }
            #message-scheduler-modal .ms-btn-primary:hover {
                transform: translateY(-1px);
                box-shadow: 0 14px 28px rgba(88, 101, 242, 0.3);
            }
            #message-scheduler-modal .ms-scheduled-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
                padding-top: 2px;
            }
            #message-scheduler-modal .ms-scheduled-row {
                display: flex;
                align-items: stretch;
                justify-content: space-between;
                gap: 10px;
                padding: 12px 14px;
                background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.015));
                border-radius: 12px;
                border: 1px solid rgba(255, 255, 255, 0.07);
                border-left: 3px solid rgba(88, 101, 242, 0.8);
            }
            #message-scheduler-modal .ms-scheduled-main {
                display: flex;
                flex-direction: column;
                gap: 3px;
                min-width: 0;
            }
            #message-scheduler-modal .ms-scheduled-title {
                font-size: 14px;
                font-weight: 700;
                line-height: 1.25;
            }
            #message-scheduler-modal .ms-scheduled-meta {
                font-size: 12px;
                color: var(--text-muted, #949ba4);
                line-height: 1.25;
            }
            #message-scheduler-modal .ms-scheduled-actions {
                display: flex;
                align-items: center;
                gap: 8px;
                flex: 0 0 auto;
            }
            #message-scheduler-modal .ms-scheduled-pill {
                display: inline-flex;
                align-items: center;
                min-height: 26px;
                padding: 0 10px;
                border-radius: 999px;
                background: rgba(88, 101, 242, 0.14);
                border: 1px solid rgba(88, 101, 242, 0.2);
                color: #ced5ff;
                font-size: 12px;
                font-weight: 600;
                white-space: nowrap;
            }
            #message-scheduler-modal .ms-scheduled-cancel {
                border: 1px solid rgba(255, 255, 255, 0.08);
                background: rgba(255, 255, 255, 0.03);
                color: var(--text-muted, #949ba4);
                cursor: pointer;
                font-size: 12px;
                font-weight: 600;
                padding: 6px 10px;
                border-radius: 10px;
                transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease;
            }
            #message-scheduler-modal .ms-scheduled-cancel:hover {
                background: rgba(255, 255, 255, 0.08);
                color: var(--text-normal, #dbdee1);
                transform: translateY(-1px);
            }
            #message-scheduler-modal .ms-empty {
                font-size: 12px;
                color: var(--text-muted, #949ba4);
                padding: 8px 0;
            }
            .ms-attachment-menu-item {
                display: flex;
                align-items: center;
                gap: 12px;
                width: calc(100% - 12px);
                min-height: 56px;
                margin: 6px 6px 8px;
                padding: 10px 12px;
                border: 1px solid rgba(88, 101, 242, 0.18);
                border-radius: 14px;
                background: linear-gradient(180deg, rgba(88, 101, 242, 0.16), rgba(88, 101, 242, 0.08));
                color: var(--interactive-normal, #b5bac1);
                cursor: pointer;
                font: inherit;
                text-align: left;
                flex: 0 0 100%;
                align-self: stretch;
                box-shadow: 0 8px 16px rgba(0, 0, 0, 0.14);
                transition: transform 0.15s ease, background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
            }
            .ms-attachment-menu-item:hover,
            .ms-attachment-menu-item:focus-visible {
                background: linear-gradient(180deg, rgba(88, 101, 242, 0.22), rgba(88, 101, 242, 0.12));
                color: var(--interactive-active, #ffffff);
                outline: none;
                transform: translateY(-1px);
                box-shadow: 0 14px 24px rgba(0, 0, 0, 0.18);
            }
            .ms-attachment-menu-icon {
                width: 30px;
                height: 30px;
                flex: 0 0 30px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border-radius: 10px;
                background: rgba(13, 16, 29, 0.34);
                border: 1px solid rgba(255, 255, 255, 0.08);
                color: #ffffff;
                font-size: 15px;
            }
            .ms-attachment-menu-content {
                display: flex;
                flex-direction: column;
                min-width: 0;
                gap: 3px;
            }
            .ms-attachment-menu-label {
                font-size: 14px;
                font-weight: 700;
                line-height: 1.15;
            }
            .ms-attachment-menu-subtext {
                font-size: 12px;
                line-height: 1.25;
                color: var(--text-muted, #949ba4);
            }
        `;

        if (this.DOM?.addStyle) {
            this.DOM.addStyle(this.cssId, css);
            return;
        }

        const existingStyle = document.getElementById(this.cssId);
        if (existingStyle) existingStyle.remove();

        const style = document.createElement("style");
        style.id = this.cssId;
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    removeCSS() {
        if (this.DOM?.removeStyle) {
            this.DOM.removeStyle(this.cssId);
            return;
        }

        const style = document.getElementById(this.cssId);
        if (style) style.remove();
    }

    observeAttachmentMenus() {
        if (!document.body) {
            return;
        }

        this.disconnectAttachmentObserver();
        this.menuObserver = new MutationObserver(() => {
            this.scheduleAttachmentMenuScan();
        });
        this.menuObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    disconnectAttachmentObserver() {
        if (this.menuObserver) {
            this.menuObserver.disconnect();
            this.menuObserver = null;
        }
    }

    scheduleAttachmentMenuScan() {
        this.clearAttachmentMenuScan();
        this.menuScanTimeout = window.setTimeout(() => {
            this.menuScanTimeout = null;
            this.scanForAttachmentMenus();
        }, 75);
    }

    clearAttachmentMenuScan() {
        if (this.menuScanTimeout) {
            window.clearTimeout(this.menuScanTimeout);
            this.menuScanTimeout = null;
        }
    }

    scanForAttachmentMenus() {
        const candidates = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="menu"]'));

        for (const candidate of candidates) {
            if (!(candidate instanceof HTMLElement)) {
                continue;
            }

            if (candidate.id === this.modalId || candidate.closest?.(`#${this.modalId}`)) {
                continue;
            }

            const menuRoot = candidate.matches?.('[role="menu"]') ? candidate : candidate.querySelector?.('[role="menu"]') || candidate;
            if (!(menuRoot instanceof HTMLElement)) {
                continue;
            }

            const menuHost = this.findAttachmentMenuHost(menuRoot);
            if (!(menuHost instanceof HTMLElement)) {
                continue;
            }

            if (menuHost.dataset.msMenuHost === "1") {
                continue;
            }

            if (!this.isAttachmentMenu(menuRoot)) {
                continue;
            }

            this.injectAttachmentMenuItem(menuHost);
        }
    }

    findAttachmentMenuHost(menuRoot) {
        if (!(menuRoot instanceof HTMLElement)) {
            return null;
        }

        const builtInItems = Array.from(menuRoot.querySelectorAll('button, [role="menuitem"]')).filter(item => this.isAttachmentMenuItem(item));
        if (!builtInItems.length) {
            return null;
        }

        const commonAncestor = this.getCommonAncestor(builtInItems);
        if (commonAncestor instanceof HTMLElement) {
            return commonAncestor;
        }

        return menuRoot;
    }

    getCommonAncestor(elements) {
        const candidates = Array.isArray(elements) ? elements.filter(element => element instanceof HTMLElement) : [];
        if (!candidates.length) {
            return null;
        }

        let ancestor = candidates[0];
        while (ancestor) {
            if (candidates.every(element => ancestor.contains(element))) {
                return ancestor;
            }

            ancestor = ancestor.parentElement;
        }

        return null;
    }

    isAttachmentMenuItem(element) {
        if (!(element instanceof HTMLElement)) {
            return false;
        }

        const text = this.normalizeText(`${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`).toLowerCase();
        if (!text) {
            return false;
        }

        return [
            "upload a file",
            "uploader un fichier",
            "create a poll",
            "créer le sondage",
            "use apps",
            "utiliser des applications",
            "send voice message"
        ].some(label => text.includes(label));
    }

    isAttachmentMenu(menuRoot) {
        const normalizedText = this.normalizeText(menuRoot.textContent).toLowerCase();
        if (!normalizedText) {
            return false;
        }

        const hasUpload = normalizedText.includes("upload a file") || normalizedText.includes("uploader un fichier");
        const hasApps = normalizedText.includes("use apps") || normalizedText.includes("utiliser des applications");
        const hasPoll = normalizedText.includes("create a poll") || normalizedText.includes("créer le sondage") || normalizedText.includes("sondage");

        return hasUpload && (hasApps || hasPoll);
    }

    injectAttachmentMenuItem(menuRoot) {
        if (!(menuRoot instanceof HTMLElement)) {
            return false;
        }

        if (menuRoot.querySelector('[data-ms-menu-item="1"]')) {
            return false;
        }

        const menuItem = this.createAttachmentMenuItem();
        menuRoot.appendChild(menuItem);
        menuRoot.dataset.msMenuHost = "1";

        if (typeof BdApi?.DOM?.onRemoved === "function") {
            BdApi.DOM.onRemoved(menuItem, () => {
                if (!menuItem.isConnected && menuRoot.dataset.msMenuHost === "1") {
                    delete menuRoot.dataset.msMenuHost;
                }
            });
        }

        return true;
    }

    createAttachmentMenuItem() {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "ms-attachment-menu-item";
        item.setAttribute("role", "menuitem");
        item.setAttribute("aria-label", "Programmer un message");
        item.dataset.msMenuItem = "1";

        const icon = document.createElement("span");
        icon.className = "ms-attachment-menu-icon";
        icon.textContent = "⏱";

        const content = document.createElement("span");
        content.className = "ms-attachment-menu-content";

        const label = document.createElement("span");
        label.className = "ms-attachment-menu-label";
        label.textContent = "Programmer un message";

        const subtext = document.createElement("span");
        subtext.className = "ms-attachment-menu-subtext";
        subtext.textContent = "Dans x min ou à xx:xx";

        content.append(label, subtext);
        item.append(icon, content);

        const openScheduler = event => {
            event.preventDefault();
            event.stopPropagation();
            this.closeInjectedAttachmentMenus();
            this.openSchedulerModal({ channelId: this.getCurrentChannelId() });
        };

        item.addEventListener("click", openScheduler);
        item.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                openScheduler(event);
            }
        });

        return item;
    }

    closeInjectedAttachmentMenus() {
        document.querySelectorAll('[data-ms-menu-host="1"]').forEach(node => {
            if (node instanceof HTMLElement) {
                delete node.dataset.msMenuHost;
            }
        });

        document.querySelectorAll('[data-ms-menu-item="1"]').forEach(node => {
            if (node instanceof HTMLElement) {
                node.remove();
            }
        });
    }

    removeInjectedAttachmentMenuItems() {
        this.closeInjectedAttachmentMenus();
    }

    openSchedulerModal({ channelId } = {}) {
        const resolvedChannelId = channelId || this.getCurrentChannelId();
        if (!resolvedChannelId) {
            this.UI?.showToast?.("Impossible de trouver le canal.", { type: "error" });
            return;
        }

        this.activeChannelId = resolvedChannelId;
        this.renderSchedulerModal();
    }

    closeSchedulerModal(skipRender = false) {
        const modal = document.getElementById(this.modalId);
        if (modal) modal.remove();
        if (!skipRender) {
            this.activeChannelId = "";
        }
    }

    renderSchedulerModal() {
        const mountNode = this.getMountNode();
        if (!mountNode) return;

        let modal = document.getElementById(this.modalId);
        const isNew = !modal;

        if (!modal) {
            modal = document.createElement("div");
            modal.id = this.modalId;
        }

        modal.setAttribute("data-ms-backdrop", "");

        modal.innerHTML = this.getModalMarkup();

        if (isNew) {
            mountNode.appendChild(modal);
        }

        this.bindModalEvents(modal);

        const messageField = modal.querySelector("#ms-message");
        if (messageField && typeof messageField.focus === "function") {
            messageField.focus();
        }
    }

    getModalMarkup() {
        const channelLabel = this.escapeHtml(this.getChannelLabel(this.activeChannelId));
        const scheduleValue = this.escapeHtml(this.lastScheduleValue || "");

        return `
            <div class="ms-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="ms-modal-title">
                <div class="ms-modal-header">
                    <div class="ms-modal-heading">
                        <div class="ms-modal-kicker">Planification</div>
                        <div class="ms-modal-title-row">
                            <div class="ms-modal-title" id="ms-modal-title">Programmer un message</div>
                            <span class="ms-modal-chip">${channelLabel}</span>
                        </div>
                        <div class="ms-modal-subtitle">Ajoute un ou plusieurs messages, puis choisis un délai ou une heure precise.</div>
                    </div>
                    <button class="ms-modal-close" type="button" data-ms-close aria-label="Close">x</button>
                </div>
                <div class="ms-modal-body">
                    <section class="ms-section">
                        <div class="ms-section-header">
                            <span class="ms-section-title">Messages</span>
                            <span class="ms-section-hint">Sépare les blocs avec ---</span>
                        </div>
                        <textarea id="ms-message" class="ms-textarea" placeholder="Message 1\n---\nMessage 2"></textarea>
                        <div class="ms-help">Chaque bloc partira comme un message distinct.</div>
                    </section>
                    <section class="ms-section">
                        <div class="ms-section-header">
                            <span class="ms-section-title">Programmation</span>
                            <span class="ms-section-hint">Minutes ou heure locale</span>
                        </div>
                        <input id="ms-schedule" class="ms-input" placeholder="15 ou 20:30" value="${scheduleValue}" />
                        <div class="ms-help">Exemples: 15 ou 20:30</div>
                    </section>
                    <section class="ms-section">
                        <div class="ms-section-header">
                            <span class="ms-section-title">Messages programmés</span>
                            <span class="ms-section-hint">${this.queue.length} en attente</span>
                        </div>
                        <div class="ms-scheduled-list" data-ms-scheduled-list>
                            ${this.getScheduledListMarkup()}
                        </div>
                    </section>
                </div>
                <div class="ms-modal-footer">
                    <button class="ms-btn ms-btn-secondary" type="button" data-ms-cancel>Annuler</button>
                    <button class="ms-btn ms-btn-primary" type="button" data-ms-schedule>Programmer</button>
                </div>
            </div>
        `;
    }

    bindModalEvents(modal) {
        const backdrop = modal.hasAttribute("data-ms-backdrop") ? modal : modal.querySelector("[data-ms-backdrop]");
        if (backdrop) {
            backdrop.addEventListener("click", event => {
                if (event.target === backdrop) {
                    this.closeSchedulerModal();
                }
            });
        }

        const closeButtons = modal.querySelectorAll("[data-ms-close], [data-ms-cancel]");
        closeButtons.forEach(button => {
            button.addEventListener("click", event => {
                event.preventDefault();
                this.closeSchedulerModal();
            });
        });

        const scheduleButton = modal.querySelector("[data-ms-schedule]");
        if (scheduleButton) {
            scheduleButton.addEventListener("click", event => {
                event.preventDefault();
                this.handleSchedule(modal);
            });
        }

        this.bindScheduledListEvents(modal);
    }

    bindScheduledListEvents(modal) {
        const cancelButtons = modal.querySelectorAll("[data-ms-cancel-id]");
        cancelButtons.forEach(button => {
            button.addEventListener("click", event => {
                event.preventDefault();
                const itemId = button.getAttribute("data-ms-cancel-id");
                if (itemId) {
                    this.removeSchedule(itemId);
                }
            });
        });
    }

    handleSchedule(modal) {
        const messageField = modal.querySelector("#ms-message");
        const scheduleField = modal.querySelector("#ms-schedule");

        const messages = this.parseMessages(messageField?.value || "");
        if (!messages.length) {
            this.UI?.showToast?.("Ajoute au moins un message.", { type: "error" });
            return;
        }

        const scheduleValue = this.cleanText(scheduleField?.value || "");
        const scheduleInfo = this.parseSchedule(scheduleValue);
        if (!scheduleInfo) {
            this.UI?.showToast?.("Indique un delai en minutes ou une heure (20:30).", { type: "error" });
            return;
        }

        const channelId = this.activeChannelId || this.getCurrentChannelId();
        if (!channelId) {
            this.UI?.showToast?.("Impossible de trouver le canal.", { type: "error" });
            return;
        }

        const item = this.createScheduleItem(channelId, messages, scheduleInfo);
        this.queue.push(item);
        this.saveQueue();
        this.scheduleTimer(item);

        this.lastScheduleValue = scheduleValue;

        if (messageField) {
            messageField.value = "";
        }

        this.refreshScheduledList(modal);
        this.UI?.showToast?.(`Message programme ${scheduleInfo.label}.`, { type: "success" });
    }

    refreshScheduledList(modal) {
        const list = modal.querySelector("[data-ms-scheduled-list]");
        if (!list) return;

        list.innerHTML = this.getScheduledListMarkup();
        this.bindScheduledListEvents(modal);
    }

    getScheduledListMarkup() {
        const items = [...this.queue].sort((a, b) => a.dueAt - b.dueAt);
        if (!items.length) {
            return `<div class="ms-empty">Aucun message programme.</div>`;
        }

        return items.map(item => {
            const channelLabel = this.escapeHtml(this.getChannelLabel(item.channelId));
            const messageCount = item.messages.length;
            const scheduleLabel = this.escapeHtml(this.getScheduleLabel(item));
            const shortTime = this.escapeHtml(this.formatTime(item.dueAt));
            return `
                <div class="ms-scheduled-row">
                    <div class="ms-scheduled-main">
                        <div class="ms-scheduled-title">${scheduleLabel}</div>
                        <div class="ms-scheduled-meta">${channelLabel} · ${messageCount} message(s)</div>
                    </div>
                    <div class="ms-scheduled-actions">
                        <span class="ms-scheduled-pill">${shortTime}</span>
                        <button class="ms-scheduled-cancel" type="button" data-ms-cancel-id="${this.escapeHtml(item.id)}">Annuler</button>
                    </div>
                </div>
            `;
        }).join("");
    }

    getScheduleLabel(item) {
        const timeLabel = this.formatTime(item.dueAt);
        const base = this.cleanText(item.scheduleLabel);
        if (!base) return `a ${timeLabel}`;
        if (base.includes(":")) return base;
        return `${base} (a ${timeLabel})`;
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        return `${hours}:${minutes}`;
    }

    createScheduleItem(channelId, messages, scheduleInfo) {
        return {
            id: this.createId(),
            channelId,
            messages,
            dueAt: scheduleInfo.dueAt,
            scheduleLabel: scheduleInfo.label,
            createdAt: Date.now()
        };
    }

    createId() {
        return `ms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    parseSchedule(value) {
        const cleanedValue = this.cleanText(value);
        if (!cleanedValue) return null;

        if (/^\d+$/.test(cleanedValue)) {
            const delayMinutes = Number.parseInt(cleanedValue, 10);
            if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) return null;

            return {
                type: "delay",
                delayMinutes,
                dueAt: Date.now() + delayMinutes * 60000,
                label: `dans ${delayMinutes} min`
            };
        }

        const timeMatch = cleanedValue.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
        if (!timeMatch) return null;

        const now = new Date();
        const targetDate = new Date(now);
        targetDate.setSeconds(0, 0);
        targetDate.setHours(Number.parseInt(timeMatch[1], 10), Number.parseInt(timeMatch[2], 10), 0, 0);

        if (targetDate.getTime() <= now.getTime()) {
            targetDate.setDate(targetDate.getDate() + 1);
        }

        const delayMinutes = Math.max(1, Math.ceil((targetDate.getTime() - now.getTime()) / 60000));

        return {
            type: "time",
            delayMinutes,
            dueAt: targetDate.getTime(),
            label: `a ${cleanedValue}`
        };
    }

    parseMessages(rawValue) {
        const rawText = typeof rawValue === "string" ? rawValue : "";
        const lines = rawText.split(/\r?\n/);
        const messages = [];
        let buffer = [];

        for (const line of lines) {
            if (/^-{3,}$/.test(line.trim())) {
                const message = buffer.join("\n").trim();
                if (message) messages.push(message);
                buffer = [];
            } else {
                buffer.push(line);
            }
        }

        const lastMessage = buffer.join("\n").trim();
        if (lastMessage) messages.push(lastMessage);

        return messages;
    }

    cleanText(value) {
        return typeof value === "string" ? value.trim() : "";
    }

    normalizeText(value) {
        return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    }

    escapeHtml(value) {
        const text = value == null ? "" : String(value);
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    loadQueue() {
        const stored = this.Data?.load?.(this.storageKey);
        if (!Array.isArray(stored)) return [];

        return stored
            .map(item => this.normalizeItem(item))
            .filter(Boolean);
    }

    saveQueue() {
        this.Data?.save?.(this.storageKey, this.queue);
    }

    normalizeItem(item) {
        if (!item || typeof item !== "object") return null;

        const channelId = typeof item.channelId === "string" ? item.channelId : "";
        const messages = Array.isArray(item.messages)
            ? item.messages.map(message => this.cleanText(message)).filter(Boolean)
            : [];
        const dueAt = Number(item.dueAt);

        if (!channelId || !messages.length || !Number.isFinite(dueAt)) return null;

        return {
            id: typeof item.id === "string" ? item.id : this.createId(),
            channelId,
            messages,
            dueAt,
            scheduleLabel: typeof item.scheduleLabel === "string" ? item.scheduleLabel : "",
            createdAt: Number(item.createdAt) || Date.now()
        };
    }

    restoreTimers() {
        this.clearAllTimers();
        for (const item of this.queue) {
            this.scheduleTimer(item);
        }
    }

    clearAllTimers() {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }

    scheduleTimer(item) {
        const delayMs = Math.max(0, item.dueAt - Date.now());
        const timerId = window.setTimeout(() => {
            void this.executeSchedule(item.id);
        }, delayMs);
        this.timers.set(item.id, timerId);
    }

    async executeSchedule(itemId) {
        const item = this.queue.find(entry => entry.id === itemId);
        if (!item) return;

        const sent = await this.sendMessages(item.messages, item.channelId);
        if (!sent) {
            this.UI?.showToast?.("Echec de l envoi des messages programmes.", { type: "error" });
        }

        this.removeSchedule(itemId);
    }

    removeSchedule(itemId) {
        const timer = this.timers.get(itemId);
        if (timer) clearTimeout(timer);
        this.timers.delete(itemId);

        this.queue = this.queue.filter(item => item.id !== itemId);
        this.saveQueue();

        const modal = document.getElementById(this.modalId);
        if (modal) {
            this.refreshScheduledList(modal);
        }
    }

    async sendMessages(messages, channelId) {
        for (const message of messages) {
            const chunks = this.splitMessageForDiscord(message);
            for (let index = 0; index < chunks.length; index += 1) {
                const ok = this.sendMessageViaDiscordApi(chunks[index], channelId);
                if (!ok) return false;

                if (index < chunks.length - 1) {
                    await this.pause(180);
                }
            }

            await this.pause(240);
        }

        return true;
    }

    splitMessageForDiscord(message, maxLength = 2000) {
        const cleanedMessage = this.cleanText(message);
        if (!cleanedMessage) return [];
        if (cleanedMessage.length <= maxLength) return [cleanedMessage];

        const chunks = [];
        let remaining = cleanedMessage;

        while (remaining.length > maxLength) {
            let splitIndex = remaining.lastIndexOf("\n", maxLength);
            if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(" ", maxLength);
            if (splitIndex <= 0) splitIndex = maxLength;

            const chunk = remaining.slice(0, splitIndex).trimEnd();
            if (chunk.length) chunks.push(chunk);

            remaining = remaining.slice(splitIndex).trimStart();
        }

        if (remaining.length) chunks.push(remaining);
        return chunks;
    }

    pause(delayMs) {
        return new Promise(resolve => window.setTimeout(resolve, delayMs));
    }

    getMessageActions() {
        try {
            return this.Webpack?.getByKeys?.("sendMessage", "editMessage") || null;
        } catch {
            return null;
        }
    }

    sendMessageViaDiscordApi(message, channelId) {
        const actions = this.getMessageActions();
        if (!actions || typeof actions.sendMessage !== "function" || !channelId) return false;

        try {
            actions.sendMessage(channelId, {
                content: message,
                tts: false,
                invalidEmojis: [],
                validNonShortcutEmojis: []
            }, true, {});
            return true;
        } catch {
            return false;
        }
    }

    getCurrentChannelId() {
        try {
            const store = this.Webpack?.getStore?.("SelectedChannelStore");
            return store?.getChannelId?.() || store?.getCurrentlySelectedChannelId?.() || "";
        } catch {
            return "";
        }
    }

    getChannelLabel(channelId) {
        if (!channelId) return "Canal inconnu";
        try {
            const store = this.Webpack?.getStore?.("ChannelStore");
            const channel = store?.getChannel?.(channelId);
            if (!channel) return `Canal ${channelId}`;
            const name = channel?.name ? `#${channel.name}` : "DM";
            return name;
        } catch {
            return `Canal ${channelId}`;
        }
    }
};

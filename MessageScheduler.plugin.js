/**
 * @name MessageScheduler
 * @author camilgrondin
 * @description Schedule one or more messages after X minutes or at HH:MM.
 * @version 0.2.0
 * @source https://github.com/CamilGrondin/MessageScheduler
 * @updateUrl https://raw.githubusercontent.com/CamilGrondin/MessageScheduler/main/MessageScheduler.plugin.js
 */

/**
 * MessageScheduler - A BetterDiscord plugin for scheduling Discord messages
 *
 * ## Features
 * - Schedule messages to send after N minutes or at a specific HH:MM time
 * - Support for multiple messages per schedule
 * - Persistent storage of scheduled messages (survives Discord restarts)
 * - Live countdown timers in the UI
 * - Edit and cancel existing schedules
 * - Injected menu item in Discord's attachment picker for easy access
 *
 * ## Architecture
 * The plugin consists of several major systems:
 * 1. **Attachment Menu Integration** - Watches for Discord's menu and injects our button
 * 2. **Scheduler Modal** - The main UI for creating and managing schedules
 * 3. **Timer Management** - Handles scheduling message sends at precise times
 * 4. **Message Sending** - Sends messages via Discord's internal API
 * 5. **Storage** - Persists schedules to BetterDiscord's storage system
 */
module.exports = class MessageScheduler {
    /**
     * Constructor - Initialize the plugin
     *
     * Sets up all the necessary properties and caches for managing scheduled messages.
     * This method is called when the plugin is first loaded by BetterDiscord.
     *
     * @param {Object} meta - Metadata passed by BetterDiscord (name, author, etc)
     */
    constructor(meta = {}) {
        // ===== PLUGIN METADATA =====
        this.meta = meta;
        this.pluginName = meta.name || "MessageScheduler";

        // ===== BETTERDISCORD API INITIALIZATION =====
        // Initialize the BetterDiscord API and cache all the modules we'll need
        this.api = new BdApi(this.pluginName);
        this.React = this.api.React;              // React library (for future UI improvements)
        this.Patcher = this.api.Patcher;          // For patching/hooking Discord code
        this.Webpack = this.api.Webpack;          // Access Discord's webpack modules
        this.Data = this.api.Data;                // Persistent storage system
        this.DOM = this.api.DOM;                  // DOM manipulation utilities
        this.ContextMenu = this.api.ContextMenu;  // Context menu injection
        this.UI = this.api.UI;                    // Toast notifications
        this.Logger = this.api.Logger;            // Logging console

        // ===== CONFIGURATION CONSTANTS =====
        // These define where we store data and what IDs we use in the DOM
        this.storageKey = "scheduled-messages";   // Key for persistent storage
        this.draftStorageKey = "message-drafts";   // Key for unscheduled message drafts
        this.cssId = "message-scheduler-css";      // Style element ID
        this.modalId = "message-scheduler-modal";  // Modal dialog ID
        this.menuItemId = "message-scheduler-menu-item";  // Menu item ID

        // ===== RUNTIME STATE =====
        /**
         * @type {Array<Object>} Queue of all scheduled messages
         * Each item has: { id, channelId, messages[], dueAt, scheduleLabel, scheduleInput, createdAt }
         */
        this.queue = [];

        /**
         * @type {Map<string, number>} Maps schedule IDs to setTimeout IDs
         * Used to cancel timers when a schedule is removed
         */
        this.timers = new Map();

        /**
         * @type {number|null} ID of the interval that updates countdown timers
         * Updates the "5m 30s remaining" display every second
         */
        this.countdownTimer = null;

        /** Delay in milliseconds before retrying a failed message send (15 seconds) */
        this.retryDelayMs = 15000;

        // ===== DOM OBSERVATION STATE =====
        /**
         * @type {MutationObserver|null} Observer that watches for Discord's attachment menus
         * When we detect a menu appearing, we inject our "Schedule a message" button
         */
        this.menuObserver = null;

        /**
         * @type {number|null} Debounce timeout for menu scanning
         * We batch DOM changes together rather than running scan for each mutation
         */
        this.menuScanTimeout = null;

        // ===== MODAL UI STATE =====
        /** The channel ID for the currently open scheduler modal (empty string = no modal open) */
        this.activeChannelId = "";

        /** The last schedule value the user entered (we remember it for better UX) */
        this.lastScheduleValue = "";

        /** Selected scheduling input mode: delay in minutes or a local clock time */
        this.timingMode = "delay";

        /**
         * The ID of the schedule item being edited (empty string = creating new schedule)
         * When this is set, the modal loads this schedule's data for modification
         */
        this.editingScheduleId = "";

        // ===== WEBPACK MODULE CACHE =====
        // Discord's functionality is split into Webpack modules. We cache these for performance.
        // These modules contain internal Discord APIs we need to use.

        /**
         * @type {Object|null} Module containing Discord's message sending functions
         * Properties: sendMessage(channelId, msgObject, shouldNotify, extraOptions)
         */
        this._messageActionsCache = null;

        /**
         * @type {Object|null} Module containing the channel data store
         * Properties: getChannel(id), getGuild(id), etc
         */
        this._channelStoreCache = null;

        /**
         * @type {Object|null} Module tracking which channel is currently selected
         * Properties: getChannelId(), getCurrentlySelectedChannelId()
         */
        this._selectedChannelStoreCache = null;

        /**
         * @type {Object|null} Module containing Discord user data
         * Properties: getUser(id)
         */
        this._userStoreCache = null;

        /** @type {Object|null} Module exposing Discord's currently selected locale */
        this._localeStoreCache = null;
    }

    /**
     * Plugin lifecycle: Called when the plugin is enabled
     *
     * Initializes all plugin systems:
     * - Sets up caches for Discord's internal modules
     * - Loads previously scheduled messages from storage
     * - Injects CSS for our UI
     * - Restores timers for any pending messages
     * - Starts the countdown ticker
     * - Sets up observers for Discord's menus
     */
    start() {
        try {
            // Cache Discord's internal modules so we can use them later
            this.cacheWebpackModules();

            // Load any messages that were scheduled before the plugin stopped
            this.queue = this.loadQueue();

            // Inject our custom CSS for styling the modal and menu items
            this.injectCSS();

            // Start timers for any messages that are still pending
            this.restoreTimers();

            // Start the ticker that updates countdown displays every second
            this.startCountdownTicker();

            // Watch for when Discord opens its attachment menu
            this.observeAttachmentMenus();

            // Scan for any attachment menus that are already open
            this.scanForAttachmentMenus();
        } catch (error) {
            this.Logger?.error?.("Failed to start plugin:", error);
        }
    }

    /**
     * Plugin lifecycle: Called when the plugin is disabled
     *
     * Cleans up all resources:
     * - Removes observers and timers
     * - Removes any UI elements we injected
     * - Cancels all pending message sends
     * - Clears cached modules
     */
    stop() {
        try {
            // Stop monitoring for Discord's attachment menus
            this.disconnectAttachmentObserver();
            this.clearAttachmentMenuScan();

            // Remove any menu items we injected into Discord's UI
            this.removeInjectedAttachmentMenuItems();

            // Cancel all pending message sends
            this.clearAllTimers();

            // Stop updating the countdown displays
            this.stopCountdownTicker();

            // Close the scheduler modal if it's open
            this.closeSchedulerModal(true);

            // Remove our CSS from the page
            this.removeCSS();

            // Clear the cached modules
            this.clearWebpackCache();
        } catch (error) {
            this.Logger?.error?.("Failed to stop plugin:", error);
        }
    }

    /**
     * Find the best place to mount our modal in the DOM
     *
     * We try several options in order of preference:
     * 1. Discord's main app container (#app-mount)
     * 2. document.body
     * 3. document.documentElement (last resort)
     *
     * @returns {HTMLElement|null} The mount point for our modal
     */
    getMountNode() {
        // Discord's standard main app container
        const appMount = document.getElementById("app-mount");
        if (appMount) return appMount;

        // Fallback to body
        if (document.body) return document.body;

        // Last resort: document root
        return document.documentElement;
    }

    /**
     * Cache Discord's Webpack modules that we need
     *
     * Discord's code is split into small modules. We need to find and cache:
     * 1. The message sending module
     * 2. The channel data store
     * 3. The selected channel tracker
     *
     * These are looked up using "magic strings" - keys that identify specific modules.
     * BetterDiscord's Webpack utilities help us find them by searching for modules that
     * export functions with these names.
     */
    cacheWebpackModules() {
        try {
            // Find the module with sendMessage and editMessage functions
            this._messageActionsCache = this.Webpack?.getByKeys?.("sendMessage", "editMessage") || null;

            // Find the ChannelStore which tracks all channels and their data
            this._channelStoreCache = this.Webpack?.getStore?.("ChannelStore") || null;

            // Find the SelectedChannelStore which tracks which channel is currently active
            this._selectedChannelStoreCache = this.Webpack?.getStore?.("SelectedChannelStore") || null;

            // Find the UserStore so DM recipient IDs can be displayed as names
            this._userStoreCache = this.Webpack?.getStore?.("UserStore") || null;

            // LocaleStore is optional across Discord releases; DOM language is a fallback.
            this._localeStoreCache = this.Webpack?.getStore?.("LocaleStore") || null;
        } catch (error) {
            // If caching fails, we'll just operate with nulls (graceful degradation)
            this.Logger?.warn?.("Failed to cache webpack modules:", error);
        }
    }

    /**
     * Clear the cached Webpack modules
     * Frees up memory when the plugin is stopped
     */
    clearWebpackCache() {
        this._messageActionsCache = null;
        this._channelStoreCache = null;
        this._selectedChannelStoreCache = null;
        this._userStoreCache = null;
        this._localeStoreCache = null;
    }

    /**
     * Inject our custom CSS into the page
     *
     * All CSS is kept inline to maintain the single-file plugin requirement.
     * We define all styles for:
     * - The scheduler modal dialog
     * - Form inputs and buttons
     * - The scheduled messages list
     * - The injected attachment menu item
     */
    injectCSS() {
        // ===== MODAL STYLES =====
        // The popup dialog where users schedule messages
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
            #message-scheduler-modal .ms-recipient-chip {
                max-width: min(100%, 280px);
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
            }
            #message-scheduler-modal .ms-recipient-avatar,
            #message-scheduler-modal .ms-recipient-fallback {
                width: 18px;
                height: 18px;
                flex: 0 0 18px;
                border-radius: 50%;
                object-fit: cover;
            }
            #message-scheduler-modal .ms-recipient-fallback {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.12);
                color: var(--text-normal, #dbdee1);
                font-size: 9px;
                font-weight: 700;
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
                box-sizing: border-box;
                display: block;
                max-width: 100%;
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
                min-height: 108px;
                max-height: 260px;
                resize: vertical;
                line-height: 1.45;
                overflow: auto;
                white-space: pre-wrap;
                overflow-wrap: anywhere;
            }
            #message-scheduler-modal .ms-help {
                font-size: 12px;
                color: var(--text-muted, #949ba4);
            }
            #message-scheduler-modal .ms-timing-mode,
            #message-scheduler-modal .ms-timing-presets {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }
            #message-scheduler-modal .ms-timing-mode-button,
            #message-scheduler-modal .ms-timing-preset {
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.04);
                color: var(--interactive-normal, #b5bac1);
                cursor: pointer;
                font: inherit;
                font-size: 12px;
                font-weight: 600;
                line-height: 1;
                padding: 8px 10px;
                transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
            }
            #message-scheduler-modal .ms-timing-mode-button[aria-pressed="true"],
            #message-scheduler-modal .ms-timing-preset:hover,
            #message-scheduler-modal .ms-timing-preset:focus-visible {
                border-color: rgba(88, 101, 242, 0.48);
                background: rgba(88, 101, 242, 0.16);
                color: #dfe4ff;
                outline: none;
            }
            #message-scheduler-modal .ms-timing-preset:focus-visible {
                box-shadow: 0 0 0 3px rgba(88, 101, 242, 0.16);
            }
            #message-scheduler-modal .ms-modal-footer {
                padding: 14px 20px 18px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
                border-top: 1px solid rgba(255, 255, 255, 0.06);
                background: rgba(255, 255, 255, 0.02);
            }
            #message-scheduler-modal .ms-schedule-summary {
                min-width: 0;
                color: var(--text-muted, #949ba4);
                font-size: 12px;
                line-height: 1.35;
            }
            #message-scheduler-modal .ms-schedule-summary[data-ms-ready="true"] {
                color: #cfd7ff;
            }
            #message-scheduler-modal .ms-modal-actions {
                display: flex;
                align-items: center;
                gap: 8px;
                flex: 0 0 auto;
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
            #message-scheduler-modal .ms-btn-primary:disabled {
                cursor: not-allowed;
                opacity: 0.45;
                transform: none;
                box-shadow: none;
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
            #message-scheduler-modal .ms-scheduled-recipient {
                display: flex;
                align-items: center;
                gap: 6px;
                min-width: 0;
            }
            #message-scheduler-modal .ms-scheduled-recipient .ms-recipient-avatar,
            #message-scheduler-modal .ms-scheduled-recipient .ms-recipient-fallback {
                width: 16px;
                height: 16px;
                flex-basis: 16px;
            }
            #message-scheduler-modal .ms-scheduled-preview {
                overflow: hidden;
                color: var(--text-muted, #949ba4);
                font-size: 12px;
                line-height: 1.3;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            #message-scheduler-modal .ms-scheduled-actions {
                display: flex;
                align-items: center;
                gap: 8px;
                flex: 0 0 auto;
                flex-wrap: wrap;
                justify-content: flex-end;
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
            #message-scheduler-modal .ms-scheduled-countdown {
                display: inline-flex;
                align-items: center;
                min-height: 26px;
                padding: 0 10px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.08);
                color: var(--text-normal, #dbdee1);
                font-size: 12px;
                font-weight: 600;
                white-space: nowrap;
            }
            #message-scheduler-modal .ms-scheduled-edit {
                border: 1px solid rgba(88, 101, 242, 0.22);
                background: rgba(88, 101, 242, 0.12);
                color: #dfe4ff;
                cursor: pointer;
                font-size: 12px;
                font-weight: 600;
                padding: 6px 10px;
                border-radius: 10px;
                transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease;
            }
            #message-scheduler-modal .ms-scheduled-edit:hover {
                background: rgba(88, 101, 242, 0.18);
                color: #ffffff;
                transform: translateY(-1px);
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
                display: inline-flex;
                align-items: center;
                gap: 5px;
                transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease;
            }
            #message-scheduler-modal .ms-scheduled-cancel svg {
                width: 13px;
                height: 13px;
                fill: none;
                stroke: currentColor;
                stroke-linecap: round;
                stroke-linejoin: round;
                stroke-width: 2;
            }
            #message-scheduler-modal .ms-scheduled-cancel:hover {
                background: rgba(255, 255, 255, 0.08);
                color: var(--text-normal, #dbdee1);
                transform: translateY(-1px);
            }
            #message-scheduler-modal .ms-scheduled-cancel[data-ms-confirming="true"] {
                border-color: rgba(237, 66, 69, 0.45);
                background: rgba(237, 66, 69, 0.16);
                color: #ffb3b5;
            }
            #message-scheduler-modal .ms-empty {
                font-size: 12px;
                color: var(--text-muted, #949ba4);
                padding: 8px 0;
            }
            @media (max-width: 560px) {
                #message-scheduler-modal .ms-modal-footer {
                    align-items: stretch;
                    flex-direction: column;
                }
                #message-scheduler-modal .ms-modal-actions {
                    justify-content: flex-end;
                }
                #message-scheduler-modal .ms-scheduled-row {
                    align-items: flex-start;
                    flex-direction: column;
                }
                #message-scheduler-modal .ms-scheduled-actions {
                    width: 100%;
                    justify-content: flex-start;
                }
            }
            .ms-attachment-menu-item {
                display: flex;
                align-items: center;
                width: 100%;
                min-height: 40px;
                margin: 0;
                padding: 8px 12px;
                border: 0;
                border-radius: 4px;
                background: transparent;
                color: var(--interactive-normal, #b5bac1);
                cursor: pointer;
                font: inherit;
                text-align: left;
                flex: 0 0 100%;
                align-self: stretch;
            }
            .ms-attachment-menu-item:hover,
            .ms-attachment-menu-item:focus-visible {
                background: var(--background-modifier-hover, rgba(255, 255, 255, 0.06));
                color: var(--interactive-hover, #dbdee1);
                outline: none;
            }
            .ms-attachment-menu-icon {
                width: 20px;
                height: 20px;
                flex: 0 0 20px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                color: currentColor;
            }
            .ms-attachment-menu-icon svg {
                width: 20px;
                height: 20px;
                fill: none;
                stroke: currentColor;
                stroke-linecap: round;
                stroke-linejoin: round;
                stroke-width: 2;
            }
            .ms-attachment-menu-content {
                display: flex;
                align-items: center;
                min-width: 0;
                margin-left: 8px;
            }
            .ms-attachment-menu-label {
                font-size: 14px;
                font-weight: 400;
                line-height: 20px;
            }
        `;

        // Try to inject using BetterDiscord's DOM API first
        if (this.DOM?.addStyle) {
            this.DOM.addStyle(this.cssId, css);
            return;
        }

        // Fallback: manually create and inject a <style> element
        const existingStyle = document.getElementById(this.cssId);
        if (existingStyle) existingStyle.remove();

        const style = document.createElement("style");
        style.id = this.cssId;
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    /**
     * Remove our CSS from the page
     * Called when the plugin is stopped
     */
    removeCSS() {
        // Try BetterDiscord's API first
        if (this.DOM?.removeStyle) {
            this.DOM.removeStyle(this.cssId);
            return;
        }

        // Fallback: manually remove the style element
        const style = document.getElementById(this.cssId);
        if (style) style.remove();
    }

    // ===== ATTACHMENT MENU INTEGRATION =====
    // This section handles injecting our "Schedule a message" button into Discord's
    // attachment picker menu. We watch for the menu to appear and inject our item.

    /**
     * Start monitoring the DOM for Discord's attachment menus
     *
     * We use a MutationObserver to watch for new dialogs and menus appearing.
     * When we detect changes, we scan for attachment menus and inject our button.
     */
    observeAttachmentMenus() {
        if (!document.body) {
            this.Logger?.warn?.("Document body not available for observation");
            return;
        }

        // Clean up any existing observer first
        this.disconnectAttachmentObserver();

        try {
            // Create a mutation observer to watch for DOM changes
            this.menuObserver = new MutationObserver(() => {
                // When we detect changes, schedule a scan (debounced)
                this.scheduleAttachmentMenuScan();
            });

            // Start observing the entire DOM for added/removed elements
            this.menuObserver.observe(document.body, {
                childList: true,  // Watch for added/removed child elements
                subtree: true     // Watch all descendants, not just direct children
            });
        } catch (error) {
            this.Logger?.error?.("Failed to set up mutation observer:", error);
        }
    }

    /**
     * Stop monitoring for attachment menus
     */
    disconnectAttachmentObserver() {
        if (this.menuObserver) {
            this.menuObserver.disconnect();
            this.menuObserver = null;
        }
    }

    /**
     * Debounce the attachment menu scan
     *
     * When the DOM changes, we don't want to scan immediately because multiple changes
     * might happen in quick succession. Instead, we wait 75ms to batch them together.
     */
    scheduleAttachmentMenuScan() {
        // Clear any pending scan first
        this.clearAttachmentMenuScan();

        // Schedule a new scan 75ms from now
        this.menuScanTimeout = window.setTimeout(() => {
            this.menuScanTimeout = null;
            this.scanForAttachmentMenus();
        }, 75);
    }

    /**
     * Cancel any pending attachment menu scan
     */
    clearAttachmentMenuScan() {
        if (this.menuScanTimeout) {
            window.clearTimeout(this.menuScanTimeout);
            this.menuScanTimeout = null;
        }
    }

    /**
     * Scan the DOM for Discord's attachment menus and inject our custom item
     *
     * This method:
     * 1. Finds all dialog and menu elements
     * 2. Identifies which ones are attachment menus (by looking for "Upload file", "Use apps", etc)
     * 3. Finds the right place to inject our button
     * 4. Injects our "Schedule a message" button if not already injected
     */
    scanForAttachmentMenus() {
        // Look for possible attachment menu containers (dialogs and menus)
        const candidates = Array.from(
            document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="menu"]')
        );

        // Check each potential menu
        for (const candidate of candidates) {
            if (!(candidate instanceof HTMLElement)) {
                continue;
            }

            // Skip our own modal to avoid infinite loops
            if (candidate.id === this.modalId || candidate.closest?.(`#${this.modalId}`)) {
                continue;
            }

            // Find the actual menu within the dialog/modal
            const menuRoot = candidate.matches?.('[role="menu"]')
                ? candidate
                : candidate.querySelector?.('[role="menu"]') || candidate;

            if (!(menuRoot instanceof HTMLElement)) {
                continue;
            }

            // Find the container where we should inject our menu item
            const menuHost = this.findAttachmentMenuHost(menuRoot);
            if (!(menuHost instanceof HTMLElement)) {
                continue;
            }

            // Skip if we've already injected into this menu
            if (menuHost.dataset.msMenuHost === "1") {
                continue;
            }

            // Verify this is actually an attachment menu
            if (!this.isAttachmentMenu(menuRoot)) {
                continue;
            }

            // Inject our menu item
            this.injectAttachmentMenuItem(menuHost);
        }
    }

    /**
     * Find the correct container element within an attachment menu
     *
     * We look for Discord's built-in menu items (Upload, Apps, Poll) and find
     * their common ancestor. That's where we'll inject our button.
     *
     * @param {HTMLElement} menuRoot - The menu element to search
     * @returns {HTMLElement|null} The container where we should inject, or null
     */
    findAttachmentMenuHost(menuRoot) {
        if (!(menuRoot instanceof HTMLElement)) {
            return null;
        }

        // Find Discord's built-in menu items
        const builtInItems = Array.from(
            menuRoot.querySelectorAll('button, [role="menuitem"]')
        ).filter(item => this.isAttachmentMenuItem(item));

        if (!builtInItems.length) {
            return null;
        }

        // Find the common ancestor of these items
        // This is usually the container where new items should be added
        const commonAncestor = this.getCommonAncestor(builtInItems);
        if (commonAncestor instanceof HTMLElement) {
            return commonAncestor;
        }

        // Fallback: use the menu root itself
        return menuRoot;
    }

    /**
     * Find the lowest common ancestor of multiple DOM elements
     *
     * For example, if you have elements at:
     *   #menu > #group > button.item1
     *   #menu > #group > button.item2
     * This returns #group (the common ancestor)
     *
     * @param {Array<HTMLElement>} elements
     * @returns {HTMLElement|null}
     */
    getCommonAncestor(elements) {
        const candidates = Array.isArray(elements)
            ? elements.filter(element => element instanceof HTMLElement)
            : [];

        if (!candidates.length) {
            return null;
        }

        // Start with the first element
        let ancestor = candidates[0];

        // Move up the tree until we find an ancestor that contains all elements
        while (ancestor) {
            if (candidates.every(element => ancestor.contains(element))) {
                return ancestor;
            }
            ancestor = ancestor.parentElement;
        }

        return null;
    }

    /**
     * Check if an element looks like one of Discord's attachment menu items
     *
     * We look for specific text like:
     * - "Upload a file" / "Uploader un fichier"
     * - "Use apps" / "Utiliser des applications"
     * - "Create a poll" / "Créer le sondage"
     * - "Send voice message"
     *
     * @param {HTMLElement} element
     * @returns {boolean}
     */
    isAttachmentMenuItem(element) {
        if (!(element instanceof HTMLElement)) {
            return false;
        }

        // Get text from both aria-label and element content
        const text = this.normalizeText(
            `${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`
        ).toLowerCase();

        if (!text) {
            return false;
        }

        // Check against known Discord menu item labels
        // Supporting both English and French
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

    /**
     * Check if an element is the Discord attachment menu
     *
     * An attachment menu should have:
     * - "Upload a file" AND
     * - ("Use apps" OR "Create a poll")
     *
     * @param {HTMLElement} menuRoot
     * @returns {boolean}
     */
    isAttachmentMenu(menuRoot) {
        const normalizedText = this.normalizeText(menuRoot.textContent).toLowerCase();
        if (!normalizedText) {
            return false;
        }

        // Check for identifying features
        const hasUpload = normalizedText.includes("upload a file") || normalizedText.includes("uploader un fichier");
        const hasApps = normalizedText.includes("use apps") || normalizedText.includes("utiliser des applications");
        const hasPoll = normalizedText.includes("create a poll") || normalizedText.includes("créer le sondage") || normalizedText.includes("sondage");

        // It's an attachment menu if it has upload AND (apps or poll)
        return hasUpload && (hasApps || hasPoll);
    }

    /**
     * Inject our "Schedule a message" menu item into a Discord attachment menu
     *
     * @param {HTMLElement} menuRoot - The menu container
     * @returns {boolean} - Whether injection was successful
     */
    injectAttachmentMenuItem(menuRoot) {
        if (!(menuRoot instanceof HTMLElement)) {
            return false;
        }

        // Don't inject twice into the same menu
        if (menuRoot.querySelector('[data-ms-menu-item="1"]')) {
            return false;
        }

        // Create our custom menu item
        const menuItem = this.createAttachmentMenuItem();
        menuRoot.appendChild(menuItem);

        // Mark this menu as having our injection
        menuRoot.dataset.msMenuHost = "1";

        // Register cleanup: when the menu item is removed, clean up the marker
        if (typeof BdApi?.DOM?.onRemoved === "function") {
            BdApi.DOM.onRemoved(menuItem, () => {
                if (menuRoot && menuRoot.isConnected && menuRoot.dataset.msMenuHost === "1") {
                    delete menuRoot.dataset.msMenuHost;
                }
            });
        }

        return true;
    }

    /**
     * Create the DOM element for our "Schedule a message" menu item
     *
     * @returns {HTMLElement}
     */
    createAttachmentMenuItem() {
        let isOpening = false;

        // Create button element
        const item = document.createElement("button");
        item.type = "button";
        item.className = "ms-attachment-menu-item";
        item.setAttribute("role", "menuitem");
        item.setAttribute("aria-label", this.t("scheduleMessage"));
        item.dataset.msMenuItem = "1";

        // Icon styled like Discord's native attachment-menu icons.
        const icon = document.createElement("span");
        icon.className = "ms-attachment-menu-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="8.5"></circle>
                <path d="M12 7.5v5l3.25 2"></path>
            </svg>
        `;

        // Content wrapper
        const content = document.createElement("span");
        content.className = "ms-attachment-menu-content";

        // Main label
        const label = document.createElement("span");
        label.className = "ms-attachment-menu-label";
        label.textContent = this.t("scheduleMessage");

        content.append(label);
        item.append(icon, content);

        // Handler for opening the scheduler
        const openScheduler = event => {
            event.preventDefault();
            event.stopPropagation();

            // A keyboard activation can be followed by a click. Only open one modal.
            if (isOpening) return;
            isOpening = true;

            // Save the channel before the popout is dismissed.
            const channelId = this.getCurrentChannelId();

            // Close Discord's attachment menu before mounting our modal. Opening both
            // in the same event turn leaves the attachment popout visible on current
            // Discord builds.
            this.closeDiscordAttachmentMenu(item);

            // Close any of our injected menus
            this.closeInjectedAttachmentMenus();

            // Let Discord process the popout dismissal before opening the scheduler.
            this.openSchedulerModalAfterAttachmentMenuCloses(channelId);
        };

        // Support both click and keyboard navigation
        item.addEventListener("click", openScheduler);
        item.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                openScheduler(event);
            }
        });

        return item;
    }

    /**
     * Remove all our injected menu items from Discord's attachment menus
     */
    closeInjectedAttachmentMenus() {
        // Clear all host markers
        document.querySelectorAll('[data-ms-menu-host="1"]').forEach(node => {
            if (node instanceof HTMLElement) {
                delete node.dataset.msMenuHost;
            }
        });

        // Remove all our injected menu items
        document.querySelectorAll('[data-ms-menu-item="1"]').forEach(node => {
            if (node instanceof HTMLElement) {
                node.remove();
            }
        });
    }

    /**
     * Remove injected attachment menu items (cleanup alias)
     */
    removeInjectedAttachmentMenuItems() {
        this.closeInjectedAttachmentMenus();
    }

    /**
     * Close Discord's attachment menu through its expanded trigger, then notify its
     * keyboard handler as a compatibility fallback.
     *
     * @param {HTMLElement} sourceItem - The item selected in the attachment menu
     */
    closeDiscordAttachmentMenu(sourceItem) {
        try {
            const menu = sourceItem?.closest?.('[role="menu"], [role="dialog"], [aria-modal="true"]') || null;
            const openTriggers = Array.from(document.querySelectorAll('[aria-expanded="true"]'));
            const trigger = openTriggers.find(element =>
                element instanceof HTMLElement &&
                !element.closest(`#${this.modalId}`) &&
                !menu?.contains(element)
            );

            // The attachment button owns the popout state. Clicking it again closes
            // the popout through Discord rather than removing Discord-owned markup.
            if (trigger) {
                trigger.click();
            }

            const escapeOptions = {
                key: "Escape",
                code: "Escape",
                keyCode: 27,
                which: 27,
                bubbles: true,
                cancelable: true
            };

            // Some Discord releases use a document-level Escape handler instead.
            // Dispatch to both the relevant popout and the document for that case.
            if (menu?.isConnected) {
                menu.dispatchEvent(new KeyboardEvent("keydown", escapeOptions));
            }
            document.dispatchEvent(new KeyboardEvent("keydown", escapeOptions));
        } catch (error) {
            this.Logger?.warn?.("Failed to close Discord menu:", error);
        }
    }

    /**
     * Open the scheduler after Discord has processed the attachment-menu dismissal.
     *
     * @param {string} channelId - Channel selected when the menu item was activated
     */
    openSchedulerModalAfterAttachmentMenuCloses(channelId) {
        const open = () => this.openSchedulerModal({ channelId });

        if (typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(() => window.requestAnimationFrame(open));
            return;
        }

        window.setTimeout(open, 0);
    }

    // ===== SCHEDULER MODAL =====
    // Main UI for creating and managing message schedules

    /**
     * Open the scheduler modal for a specific channel
     *
     * @param {Object} options - Configuration
     * @param {string} options.channelId - Channel ID (optional, uses current if not provided)
     */
    openSchedulerModal({ channelId } = {}) {
        // Use provided channel or current channel
        const resolvedChannelId = channelId || this.getCurrentChannelId();
        if (!resolvedChannelId) {
            this.Logger?.warn?.("Cannot open modal: no channel selected");
            this.UI?.showToast?.("Unable to find the channel.", { type: "error" });
            return;
        }

        this.activeChannelId = resolvedChannelId;
        this.renderSchedulerModal();
    }

    /**
     * Close the scheduler modal
     *
     * @param {boolean} skipRender - Internal flag: if true, don't clear modal state
     */
    closeSchedulerModal(skipRender = false) {
        try {
            const modal = document.getElementById(this.modalId);
            if (modal && modal.isConnected) {
                if (!skipRender) {
                    this.saveDraftFromModal(modal);
                }
                modal.remove();
            }
        } catch (error) {
            this.Logger?.warn?.("Error closing modal:", error);
        }

        // Clear state unless in cleanup mode
        if (!skipRender) {
            this.activeChannelId = "";
            this.editingScheduleId = "";
        }
    }

    /**
     * Render the scheduler modal
     *
     * Creates or updates the modal HTML and attaches event listeners.
     */
    renderSchedulerModal() {
        const mountNode = this.getMountNode();
        if (!mountNode) {
            this.Logger?.warn?.("Cannot render modal: mount node not found");
            return;
        }

        // Check if modal already exists
        let modal = document.getElementById(this.modalId);
        const isNew = !modal;

        // Create new modal if needed
        if (!modal) {
            modal = document.createElement("div");
            modal.id = this.modalId;
        }

        // Mark as a backdrop
        modal.setAttribute("data-ms-backdrop", "");

        try {
            // Generate and set the HTML
            modal.innerHTML = this.getModalMarkup();
        } catch (error) {
            this.Logger?.error?.("Failed to render modal markup:", error);
            return;
        }

        // Add to DOM if new
        if (isNew) {
            mountNode.appendChild(modal);
        }

        try {
            // Attach event listeners
            this.bindModalEvents(modal);
        } catch (error) {
            this.Logger?.error?.("Failed to bind modal events:", error);
        }

        // Focus the message input
        const messageField = modal.querySelector("#ms-message");
        if (messageField && typeof messageField.focus === "function") {
            messageField.focus();
        }
    }

    /**
     * Generate the HTML markup for the scheduler modal
     *
     * @returns {string} HTML for the modal
     */
    getModalMarkup() {
        const isEditing = Boolean(this.editingScheduleId);
        const editingItem = isEditing ? this.queue.find(entry => entry.id === this.editingScheduleId) : null;
        const draft = isEditing ? "" : this.getDraft(this.activeChannelId);
        const messageValue = this.escapeHtml(editingItem ? editingItem.messages.join("\n---\n") : draft);
        const rawScheduleValue = editingItem
            ? (editingItem.scheduleInput || editingItem.scheduleLabel || "")
            : (this.lastScheduleValue || "");
        const scheduleValue = this.escapeHtml(rawScheduleValue);
        this.timingMode = this.getTimingMode(rawScheduleValue);

        const destination = this.getScheduledDestination(this.activeChannelId);
        const destinationMarkup = this.getDestinationMarkup(destination, "ms-recipient-chip");
        const modalTitle = this.t(isEditing ? "editScheduledMessage" : "scheduleMessage");
        const actionLabel = this.t(isEditing ? "update" : "schedule");
        const scheduledSection = this.queue.length ? `
            <section class="ms-section">
                <div class="ms-section-header">
                    <span class="ms-section-title">${this.t("scheduledMessages")}</span>
                    <span class="ms-section-hint">${this.formatPendingCount(this.queue.length)}</span>
                </div>
                <div class="ms-scheduled-list" data-ms-scheduled-list>
                    ${this.getScheduledListMarkup()}
                </div>
            </section>
        ` : "";

        return `
            <div class="ms-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="ms-modal-title">
                <div class="ms-modal-header">
                    <div class="ms-modal-heading">
                        <div class="ms-modal-kicker">${this.t("scheduling")}</div>
                        <div class="ms-modal-title-row">
                            <div class="ms-modal-title" id="ms-modal-title">${modalTitle}</div>
                            ${destinationMarkup}
                        </div>
                        <div class="ms-modal-subtitle">${this.t("modalSubtitle")}</div>
                    </div>
                    <button class="ms-modal-close" type="button" data-ms-close aria-label="${this.t("close")}">×</button>
                </div>
                <div class="ms-modal-body">
                    <section class="ms-section">
                        <div class="ms-section-header">
                            <span class="ms-section-title">${this.t("messages")}</span>
                            <span class="ms-section-hint">${this.t("separateBlocks")}</span>
                        </div>
                        <textarea id="ms-message" class="ms-textarea" placeholder="${this.t("messagePlaceholder")}">${messageValue}</textarea>
                        <div class="ms-help">${this.t("messageHelp")}</div>
                    </section>
                    <section class="ms-section">
                        <div class="ms-section-header">
                            <span class="ms-section-title">${this.t("when")}</span>
                            <span class="ms-section-hint" data-ms-timing-hint>${this.getTimingHint()}</span>
                        </div>
                        <div class="ms-timing-mode" role="group" aria-label="${this.t("when")}">
                            <button class="ms-timing-mode-button" type="button" data-ms-timing-mode="delay" aria-pressed="${this.timingMode === "delay"}">${this.t("delay")}</button>
                            <button class="ms-timing-mode-button" type="button" data-ms-timing-mode="time" aria-pressed="${this.timingMode === "time"}">${this.t("atTime")}</button>
                        </div>
                        <div class="ms-timing-presets" data-ms-timing-presets>
                            <button class="ms-timing-preset" type="button" data-ms-timing-preset="5">${this.t("inFiveMinutes")}</button>
                            <button class="ms-timing-preset" type="button" data-ms-timing-preset="60">${this.t("inOneHour")}</button>
                            <button class="ms-timing-preset" type="button" data-ms-timing-preset="tonight">${this.t("tonight")}</button>
                            <button class="ms-timing-preset" type="button" data-ms-timing-preset="tomorrowMorning">${this.t("tomorrowMorning")}</button>
                        </div>
                        <input id="ms-schedule" class="ms-input" data-ms-schedule-input autocomplete="off" placeholder="${this.getTimingPlaceholder()}" value="${scheduleValue}" />
                        <div class="ms-help" data-ms-timing-example>${this.getTimingExample()}</div>
                    </section>
                    ${scheduledSection}
                </div>
                <div class="ms-modal-footer">
                    <div class="ms-schedule-summary" data-ms-schedule-summary aria-live="polite"></div>
                    <div class="ms-modal-actions">
                        <button class="ms-btn ms-btn-secondary" type="button" data-ms-cancel>${this.t("cancel")}</button>
                        <button class="ms-btn ms-btn-primary" type="button" data-ms-schedule>${actionLabel}</button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Read Discord's locale when available, with browser-language fallbacks.
     *
     * @returns {string}
     */
    getDiscordLocale() {
        try {
            const locale = this._localeStoreCache?.getLocale?.() ||
                this._localeStoreCache?.locale ||
                (typeof document !== "undefined" ? document.documentElement?.lang : "") ||
                (typeof navigator !== "undefined" ? navigator.language : "") ||
                "en-US";
            return String(locale);
        } catch {
            return "en-US";
        }
    }

    /**
     * Localized interface copy. The modal follows Discord's active language when it
     * is French and otherwise keeps its English copy.
     *
     * @param {string} key
     * @returns {string}
     */
    t(key) {
        const isFrench = this.getDiscordLocale().toLowerCase().startsWith("fr");
        const copy = isFrench ? {
            scheduling: "Programmation",
            scheduleMessage: "Programmer un message",
            editScheduledMessage: "Modifier le message programmé",
            modalSubtitle: "Écrivez votre ou vos messages, puis choisissez un délai ou une heure.",
            close: "Fermer",
            messages: "Messages",
            separateBlocks: "Séparez les blocs avec ---",
            messagePlaceholder: "Message 1\n---\nMessage 2",
            messageHelp: "Chaque bloc sera envoyé comme un message distinct.",
            when: "Quand",
            delay: "Délai",
            atTime: "À une heure",
            minutes: "Minutes",
            localTime: "Heure locale (HH:MM)",
            delayExample: "Exemple : 15",
            timeExample: "Exemple : 20:30",
            inFiveMinutes: "Dans 5 min",
            inOneHour: "Dans 1 h",
            tonight: "Ce soir",
            tomorrowMorning: "Demain 09:00",
            scheduledMessages: "Messages programmés",
            pending: "en attente",
            cancel: "Annuler",
            schedule: "Programmer",
            update: "Mettre à jour",
            edit: "Modifier",
            confirmCancel: "Confirmer ?",
            cancelScheduled: "Annuler ce message programmé",
            addMessage: "Ajoutez un message pour continuer.",
            chooseTiming: "Choisissez un délai ou une heure d’envoi.",
            to: "À",
            channel: "Canal",
            recipientUnknown: "Destinataire inconnu",
            recipientUnavailable: "Destinataire indisponible",
            now: "maintenant",
            at: "à",
            message: "message",
            messagesCount: "messages"
        } : {
            scheduling: "Scheduling",
            scheduleMessage: "Schedule a message",
            editScheduledMessage: "Edit scheduled message",
            modalSubtitle: "Write your message(s), then choose a delay or a time.",
            close: "Close",
            messages: "Messages",
            separateBlocks: "Separate blocks with ---",
            messagePlaceholder: "Message 1\n---\nMessage 2",
            messageHelp: "Each block is sent as its own message.",
            when: "When",
            delay: "Delay",
            atTime: "At a time",
            minutes: "Minutes",
            localTime: "Local time (HH:MM)",
            delayExample: "Example: 15",
            timeExample: "Example: 20:30",
            inFiveMinutes: "In 5 min",
            inOneHour: "In 1 hour",
            tonight: "Tonight",
            tomorrowMorning: "Tomorrow 09:00",
            scheduledMessages: "Scheduled messages",
            pending: "pending",
            cancel: "Cancel",
            schedule: "Schedule",
            update: "Update",
            edit: "Edit",
            confirmCancel: "Confirm?",
            cancelScheduled: "Cancel this scheduled message",
            addMessage: "Add a message to continue.",
            chooseTiming: "Choose a delay or send time.",
            to: "To",
            channel: "Channel",
            recipientUnknown: "Recipient unknown",
            recipientUnavailable: "DM recipient unavailable",
            now: "now",
            at: "at",
            message: "message",
            messagesCount: "messages"
        };

        return copy[key] || key;
    }

    /**
     * @param {string} value
     * @returns {"delay"|"time"}
     */
    getTimingMode(value) {
        return /^\d{1,2}:\d{2}$/.test(this.cleanText(value)) ? "time" : "delay";
    }

    /** @returns {string} */
    getTimingHint() {
        return this.timingMode === "time" ? this.t("localTime") : this.t("minutes");
    }

    /** @returns {string} */
    getTimingPlaceholder() {
        return this.timingMode === "time" ? "20:30" : "15";
    }

    /** @returns {string} */
    getTimingExample() {
        return this.timingMode === "time" ? this.t("timeExample") : this.t("delayExample");
    }

    /**
     * @param {number} count
     * @returns {string}
     */
    formatPendingCount(count) {
        const amount = Number(count) || 0;
        return `${amount} ${this.t("pending")}`;
    }

    /**
     * @param {number} count
     * @returns {string}
     */
    formatMessageCount(count) {
        const amount = Number(count) || 0;
        return `${amount} ${amount === 1 ? this.t("message") : this.t("messagesCount")}`;
    }

    /**
     * Create the value for one of the timing shortcuts.
     *
     * @param {string} preset
     * @returns {{mode: "delay"|"time", value: string}|null}
     */
    getTimingPreset(preset) {
        if (preset === "5" || preset === "60") {
            return { mode: "delay", value: preset };
        }

        const target = new Date();
        if (preset === "tonight") {
            target.setHours(20, 0, 0, 0);
            if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
        } else if (preset === "tomorrowMorning") {
            target.setDate(target.getDate() + 1);
            target.setHours(9, 0, 0, 0);
        } else {
            return null;
        }

        return {
            mode: "time",
            value: `${String(target.getHours()).padStart(2, "0")}:${String(target.getMinutes()).padStart(2, "0")}`
        };
    }

    /**
     * @param {Object} destination
     * @param {string} className
     * @returns {string}
     */
    getDestinationMarkup(destination, className = "") {
        const label = this.escapeHtml(destination?.label || this.t("recipientUnknown"));
        const avatar = this.getDestinationAvatarMarkup(destination);

        return `<span class="ms-modal-chip ${className}" title="${label}">${avatar}<span>${label}</span></span>`;
    }

    /**
     * @param {Object} destination
     * @returns {string}
     */
    getDestinationAvatarMarkup(destination) {
        return destination?.avatarUrl
            ? `<img class="ms-recipient-avatar" src="${this.escapeHtml(destination.avatarUrl)}" alt="" referrerpolicy="no-referrer" />`
            : `<span class="ms-recipient-fallback" aria-hidden="true">${this.escapeHtml(this.getInitials(destination?.label || "?"))}</span>`;
    }

    /**
     * @param {string} value
     * @returns {string}
     */
    getInitials(value) {
        return this.cleanText(value).split(/\s+/).filter(Boolean).slice(0, 2)
            .map(part => part.charAt(0).toUpperCase()).join("") || "?";
    }

    /**
     * Attach event listeners to modal buttons and backdrop
     *
     * @param {HTMLElement} modal - The modal element
     */
    bindModalEvents(modal) {
        // Close only when the press starts and ends on the backdrop. This preserves
        // text selections that begin inside the scheduler and end outside it.
        const backdrop = modal.hasAttribute("data-ms-backdrop") ? modal : modal.querySelector("[data-ms-backdrop]");
        if (backdrop) {
            let backdropPointer = null;

            backdrop.addEventListener("pointerdown", event => {
                if (!event.isPrimary || event.button !== 0) return;

                backdropPointer = {
                    id: event.pointerId,
                    startedOnBackdrop: event.target === backdrop,
                    endedOnBackdrop: false
                };
            });

            backdrop.addEventListener("pointerup", event => {
                if (!backdropPointer || event.pointerId !== backdropPointer.id) return;
                backdropPointer.endedOnBackdrop = event.target === backdrop;
            });

            backdrop.addEventListener("pointercancel", () => {
                backdropPointer = null;
            });

            backdrop.addEventListener("click", event => {
                const shouldClose = event.target === backdrop &&
                    backdropPointer?.startedOnBackdrop &&
                    backdropPointer?.endedOnBackdrop;
                backdropPointer = null;

                if (shouldClose) {
                    this.closeSchedulerModal();
                }
            });
        }

        // Close buttons
        const closeButtons = modal.querySelectorAll("[data-ms-close], [data-ms-cancel]");
        closeButtons.forEach(button => {
            button.addEventListener("click", event => {
                event.preventDefault();
                this.closeSchedulerModal();
            });
        });

        // Schedule button
        const scheduleButton = modal.querySelector("[data-ms-schedule]");
        if (scheduleButton) {
            scheduleButton.addEventListener("click", event => {
                event.preventDefault();
                this.handleSchedule(modal);
            });
        }

        const messageField = modal.querySelector("#ms-message");
        const scheduleField = modal.querySelector("#ms-schedule");
        messageField?.addEventListener("input", () => {
            this.autoResizeMessageField(messageField);
            this.updateScheduleSummary(modal);
        });
        scheduleField?.addEventListener("input", () => {
            if (this.cleanText(scheduleField.value)) {
                this.timingMode = this.getTimingMode(scheduleField.value);
                this.updateTimingControls(modal);
            }
            this.updateScheduleSummary(modal);
        });

        modal.querySelectorAll("[data-ms-timing-mode]").forEach(button => {
            button.addEventListener("click", event => {
                event.preventDefault();
                const mode = button.getAttribute("data-ms-timing-mode");
                if (mode !== "delay" && mode !== "time") return;

                this.timingMode = mode;
                this.updateTimingControls(modal);
                this.updateScheduleSummary(modal);
                scheduleField?.focus();
            });
        });

        modal.querySelectorAll("[data-ms-timing-preset]").forEach(button => {
            button.addEventListener("click", event => {
                event.preventDefault();
                const preset = this.getTimingPreset(button.getAttribute("data-ms-timing-preset") || "");
                if (!preset || !scheduleField) return;

                this.timingMode = preset.mode;
                scheduleField.value = preset.value;
                this.updateTimingControls(modal);
                this.updateScheduleSummary(modal);
                scheduleField.focus();
            });
        });

        // List event handlers
        this.bindScheduledListEvents(modal);
        this.updateTimingControls(modal);
        this.autoResizeMessageField(messageField);
        this.updateScheduleSummary(modal);
    }

    /**
     * Keep an empty composer compact while allowing longer drafts to expand without
     * making the surrounding dialog jump past a usable height.
     *
     * @param {HTMLTextAreaElement|null} field
     */
    autoResizeMessageField(field) {
        if (!field) return;

        field.style.height = "auto";
        const height = Math.min(260, Math.max(108, field.scrollHeight));
        field.style.height = `${height}px`;
        field.style.overflowY = field.scrollHeight > height ? "auto" : "hidden";
    }

    /**
     * Keep timing labels and the selected segmented control in sync.
     *
     * @param {HTMLElement} modal
     */
    updateTimingControls(modal) {
        modal.querySelectorAll("[data-ms-timing-mode]").forEach(button => {
            button.setAttribute("aria-pressed", String(button.getAttribute("data-ms-timing-mode") === this.timingMode));
        });

        const scheduleField = modal.querySelector("#ms-schedule");
        const hint = modal.querySelector("[data-ms-timing-hint]");
        const example = modal.querySelector("[data-ms-timing-example]");
        if (scheduleField) scheduleField.placeholder = this.getTimingPlaceholder();
        if (hint) hint.textContent = this.getTimingHint();
        if (example) example.textContent = this.getTimingExample();
    }

    /**
     * Render the exact send outcome and keep the primary action disabled until the
     * message and time are both valid.
     *
     * @param {HTMLElement} modal
     */
    updateScheduleSummary(modal) {
        const summary = modal.querySelector("[data-ms-schedule-summary]");
        const scheduleButton = modal.querySelector("[data-ms-schedule]");
        const messageCount = this.parseMessages(modal.querySelector("#ms-message")?.value || "").length;
        const scheduleInfo = this.parseSchedule(modal.querySelector("#ms-schedule")?.value || "");
        const isReady = Boolean(messageCount && scheduleInfo);

        if (summary) {
            summary.dataset.msReady = String(isReady);
            summary.textContent = isReady
                ? this.getScheduleSummaryText(messageCount, scheduleInfo)
                : messageCount ? this.t("chooseTiming") : this.t("addMessage");
        }

        if (scheduleButton) {
            scheduleButton.disabled = !isReady;
            scheduleButton.title = isReady ? "" : (messageCount ? this.t("chooseTiming") : this.t("addMessage"));
        }
    }

    /**
     * @param {number} messageCount
     * @param {Object} scheduleInfo
     * @returns {string}
     */
    getScheduleSummaryText(messageCount, scheduleInfo) {
        const destination = this.getScheduledDestination(this.activeChannelId);
        const time = this.formatTime(scheduleInfo.dueAt);
        const isFrench = this.getDiscordLocale().toLowerCase().startsWith("fr");
        const when = scheduleInfo.type === "delay"
            ? (isFrench
                ? `dans ${scheduleInfo.delayMinutes} min (à ${time})`
                : `in ${scheduleInfo.delayMinutes} min (at ${time})`)
            : (isFrench ? `à ${time}` : `at ${time}`);

        return isFrench
            ? `Envoi de ${this.formatMessageCount(messageCount)} à ${destination.label} ${when}.`
            : `Sending ${this.formatMessageCount(messageCount)} to ${destination.label} ${when}.`;
    }

    /**
     * Attach event listeners to scheduled message list items
     *
     * @param {HTMLElement} modal - The modal element
     */
    bindScheduledListEvents(modal) {
        // Edit buttons
        const editButtons = modal.querySelectorAll("[data-ms-edit-id]");
        editButtons.forEach(button => {
            button.addEventListener("click", event => {
                event.preventDefault();
                const itemId = button.getAttribute("data-ms-edit-id");
                if (itemId) {
                    this.beginScheduleEdit(itemId, modal);
                }
            });
        });

        // Cancel buttons
        const cancelButtons = modal.querySelectorAll("[data-ms-cancel-id]");
        cancelButtons.forEach(button => {
            button.addEventListener("click", event => {
                event.preventDefault();
                const itemId = button.getAttribute("data-ms-cancel-id");
                if (!itemId) return;

                if (button.dataset.msConfirming === "true") {
                    this.removeSchedule(itemId);
                    return;
                }

                button.dataset.msConfirming = "true";
                const label = button.querySelector("[data-ms-cancel-label]");
                if (label) label.textContent = this.t("confirmCancel");
                button.setAttribute("aria-label", this.t("confirmCancel"));
                button.title = this.t("confirmCancel");

                window.setTimeout(() => {
                    if (!button.isConnected || button.dataset.msConfirming !== "true") return;
                    delete button.dataset.msConfirming;
                    if (label) label.textContent = this.t("cancel");
                    button.setAttribute("aria-label", this.t("cancelScheduled"));
                    button.title = this.t("cancelScheduled");
                }, 3500);
            });
        });
    }

    /**
     * Handle the "Schedule" button click
     *
     * Validates inputs, creates/updates schedule, and saves to storage
     *
     * @param {HTMLElement} modal - The modal element
     */
    handleSchedule(modal) {
        try {
            // Get form fields
            const messageField = modal.querySelector("#ms-message");
            const scheduleField = modal.querySelector("#ms-schedule");

            // Parse messages
            const messages = this.parseMessages(messageField?.value || "");
            if (!messages.length) {
                this.UI?.showToast?.("Add at least one message.", { type: "error" });
                return;
            }

            // Parse schedule
            const scheduleValue = this.cleanText(scheduleField?.value || "");
            const scheduleInfo = this.parseSchedule(scheduleValue);
            if (!scheduleInfo) {
                this.UI?.showToast?.("Enter a delay in minutes or a time (20:30).", { type: "error" });
                return;
            }

            // Validate channel
            const channelId = this.activeChannelId || this.getCurrentChannelId();
            if (!channelId) {
                this.Logger?.warn?.("No channel ID available for scheduling");
                this.UI?.showToast?.("Unable to find the channel.", { type: "error" });
                return;
            }

            const wasEditing = Boolean(this.editingScheduleId);
            let savedItem = null;

            // Update or create
            if (wasEditing) {
                const existingIndex = this.queue.findIndex(entry => entry.id === this.editingScheduleId);
                if (existingIndex >= 0) {
                    const existingItem = this.queue[existingIndex];
                    this.clearScheduleTimer(existingItem.id);

                    this.queue[existingIndex] = {
                        ...existingItem,
                        channelId,
                        messages,
                        dueAt: scheduleInfo.dueAt,
                        scheduleLabel: scheduleInfo.label,
                        scheduleInput: scheduleValue,
                        updatedAt: Date.now()
                    };
                    savedItem = this.queue[existingIndex];
                    this.scheduleTimer(savedItem);
                }
            } else {
                savedItem = this.createScheduleItem(channelId, messages, scheduleInfo, scheduleValue);
                this.queue.push(savedItem);
                this.scheduleTimer(savedItem);
            }

            // Fallback
            if (!savedItem) {
                savedItem = this.createScheduleItem(channelId, messages, scheduleInfo, scheduleValue);
                this.queue.push(savedItem);
                this.scheduleTimer(savedItem);
            }

            // Save
            this.saveQueue();
            this.clearDraft(channelId);

            // Clear form
            this.lastScheduleValue = scheduleValue;
            this.editingScheduleId = "";
            if (messageField) {
                messageField.value = "";
            }

            // Update UI
            this.refreshScheduledList(modal);
            this.renderSchedulerModal();

            // Notify
            this.UI?.showToast?.(
                wasEditing ? "Scheduled message updated." : `Message scheduled ${scheduleInfo.label}.`,
                { type: "success" }
            );
        } catch (error) {
            this.Logger?.error?.("Error in handleSchedule:", error);
            this.UI?.showToast?.("Error while scheduling the message.", { type: "error" });
        }
    }

    /**
     * Refresh the list of scheduled messages in the modal
     *
     * @param {HTMLElement} modal - The modal element
     */
    refreshScheduledList(modal) {
        const list = modal.querySelector("[data-ms-scheduled-list]");
        if (!list) return;

        if (!this.queue.length) {
            list.closest(".ms-section")?.remove();
            return;
        }

        list.innerHTML = this.getScheduledListMarkup();
        this.bindScheduledListEvents(modal);
    }

    /**
     * Generate HTML for the list of scheduled messages
     *
     * @returns {string}
     */
    getScheduledListMarkup() {
        // Sort by due time
        const items = [...this.queue].sort((a, b) => a.dueAt - b.dueAt);

        if (!items.length) {
            return "";
        }

        return items.map(item => {
            const destination = this.getScheduledDestination(item.channelId);
            const recipientLabel = this.escapeHtml(this.getScheduledRecipientLabel(item.channelId));
            const recipientAvatar = this.getDestinationAvatarMarkup(destination);
            const messageCount = item.messages.length;
            const scheduleLabel = this.escapeHtml(this.getScheduleLabel(item));
            const shortTime = this.escapeHtml(this.formatTime(item.dueAt));
            const countdownLabel = this.escapeHtml(this.getCountdownLabel(item.dueAt));
            const preview = this.escapeHtml(this.getMessagePreview(item.messages));

            return `
                <div class="ms-scheduled-row">
                    <div class="ms-scheduled-main">
                        <div class="ms-scheduled-title">${scheduleLabel}</div>
                        <div class="ms-scheduled-meta ms-scheduled-recipient">${recipientAvatar}<span>${recipientLabel} · ${this.formatMessageCount(messageCount)}</span></div>
                        ${preview ? `<div class="ms-scheduled-preview">${preview}</div>` : ""}
                    </div>
                    <div class="ms-scheduled-actions">
                        <span class="ms-scheduled-countdown" data-ms-countdown-id="${this.escapeHtml(item.id)}">${countdownLabel}</span>
                        <span class="ms-scheduled-pill">${shortTime}</span>
                        <button class="ms-scheduled-edit" type="button" data-ms-edit-id="${this.escapeHtml(item.id)}">${this.t("edit")}</button>
                        <button class="ms-scheduled-cancel" type="button" data-ms-cancel-id="${this.escapeHtml(item.id)}" aria-label="${this.t("cancelScheduled")}" title="${this.t("cancelScheduled")}">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M9 7l1-2h4l1 2M6 7l1 13h10l1-13"></path></svg>
                            <span data-ms-cancel-label>${this.t("cancel")}</span>
                        </button>
                    </div>
                </div>
            `;
        }).join("");
    }

    /**
     * @param {Array<string>} messages
     * @returns {string}
     */
    getMessagePreview(messages) {
        const firstMessage = Array.isArray(messages) ? messages[0] : "";
        const preview = this.cleanText(firstMessage).replace(/\s+/g, " ");
        return preview.length > 96 ? `${preview.slice(0, 93).trimEnd()}…` : preview;
    }

    /**
     * Get a label for a scheduled message
     *
     * @param {Object} item - Scheduled message item
     * @returns {string}
     */
    getScheduleLabel(item) {
        const timeLabel = this.formatTime(item.dueAt);
        const base = this.cleanText(item.scheduleLabel);
        if (!base) return `${this.t("at")} ${timeLabel}`;
        if (base.includes(":")) return base;
        return `${base} (${this.t("at")} ${timeLabel})`;
    }

    /**
     * Format a timestamp as HH:MM
     *
     * @param {number} timestamp - Milliseconds since epoch
     * @returns {string}
     */
    formatTime(timestamp) {
        const date = new Date(timestamp);
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        return `${hours}:${minutes}`;
    }

    /**
     * Get a countdown label for a scheduled message
     *
     * Returns text like "5h 23m", "45m 10s", or "30s"
     *
     * @param {number} timestamp - When the message should be sent
     * @returns {string}
     */
    getCountdownLabel(timestamp) {
        const remainingMs = timestamp - Date.now();

        if (remainingMs <= 0) {
            return "Pending";
        }

        const totalSeconds = Math.ceil(remainingMs / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return `${hours}h ${String(minutes).padStart(2, "0")}m`;
        }

        if (minutes > 0) {
            return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
        }

        return `${seconds}s`;
    }

    // ===== COUNTDOWN TICKER =====

    /**
     * Start the countdown ticker
     *
     * Updates the countdown displays every second
     */
    startCountdownTicker() {
        this.stopCountdownTicker();

        this.countdownTimer = window.setInterval(() => {
            this.updateCountdownLabels();
        }, 1000);

        this.updateCountdownLabels();
    }

    /**
     * Stop the countdown ticker
     */
    stopCountdownTicker() {
        if (this.countdownTimer) {
            window.clearInterval(this.countdownTimer);
            this.countdownTimer = null;
        }
    }

    /**
     * Update all countdown displays in the modal
     */
    updateCountdownLabels() {
        const modal = document.getElementById(this.modalId);
        if (!modal || !modal.isConnected) return;

        const rows = modal.querySelectorAll("[data-ms-countdown-id]");
        rows.forEach(row => {
            if (!(row instanceof HTMLElement)) return;

            const itemId = row.getAttribute("data-ms-countdown-id");
            if (!itemId) return;

            const item = this.queue.find(entry => entry.id === itemId);
            if (!item) return;

            row.textContent = this.getCountdownLabel(item.dueAt);
        });
    }

    // ===== SCHEDULE EDITING =====

    /**
     * Begin editing a scheduled message
     *
     * @param {string} itemId - ID of the schedule to edit
     * @param {HTMLElement} modal - The modal element
     */
    beginScheduleEdit(itemId, modal) {
        const item = this.queue.find(entry => entry.id === itemId);
        if (!item) return;

        this.editingScheduleId = itemId;
        this.lastScheduleValue = item.scheduleInput || item.scheduleLabel || this.lastScheduleValue;

        this.renderSchedulerModal();
    }

    /**
     * Cancel a timer for a scheduled message
     *
     * @param {string} itemId - ID of the schedule
     */
    clearScheduleTimer(itemId) {
        const timer = this.timers.get(itemId);
        if (timer) {
            clearTimeout(timer);
        }
        this.timers.delete(itemId);
    }

    // ===== SCHEDULE ITEM MANAGEMENT =====

    /**
     * Create a new schedule item
     *
     * @param {string} channelId - Discord channel ID
     * @param {Array<string>} messages - Messages to send
     * @param {Object} scheduleInfo - Timing information
     * @param {string} scheduleInput - User's original input
     * @returns {Object}
     */
    createScheduleItem(channelId, messages, scheduleInfo, scheduleInput = "") {
        return {
            id: this.createId(),
            channelId,
            messages,
            dueAt: scheduleInfo.dueAt,
            scheduleLabel: scheduleInfo.label,
            scheduleInput: this.cleanText(scheduleInput),
            createdAt: Date.now()
        };
    }

    /**
     * Generate a unique ID for a schedule item
     *
     * Uses timestamp + random hash for uniqueness
     *
     * @returns {string}
     */
    createId() {
        return `ms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    // ===== PARSING & VALIDATION =====

    /**
     * Parse a user-entered schedule value
     *
     * Accepts:
     * - A number (minutes): "15", "30"
     * - A time (HH:MM): "20:30", "14:45"
     *
     * @param {string} value
     * @returns {Object|null} { type, delayMinutes, dueAt, label } or null
     */
    parseSchedule(value) {
        const cleanedValue = this.cleanText(value);
        if (!cleanedValue) return null;

        // Try parsing as minutes
        if (/^\d+$/.test(cleanedValue)) {
            const delayMinutes = Number.parseInt(cleanedValue, 10);

            if (!Number.isFinite(delayMinutes) || delayMinutes < 0 || delayMinutes > 5256000) {
                return null;
            }

            return {
                type: "delay",
                delayMinutes,
                dueAt: Date.now() + delayMinutes * 60000,
                label: delayMinutes === 0
                    ? this.t("now")
                    : (this.getDiscordLocale().toLowerCase().startsWith("fr")
                        ? `dans ${delayMinutes} min`
                        : `in ${delayMinutes} min`)
            };
        }

        // Try parsing as HH:MM time
        const timeMatch = cleanedValue.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
        if (!timeMatch) return null;

        const now = new Date();
        const targetDate = new Date(now);
        targetDate.setSeconds(0, 0);
        targetDate.setHours(
            Number.parseInt(timeMatch[1], 10),
            Number.parseInt(timeMatch[2], 10),
            0,
            0
        );

        // If time has passed, schedule for tomorrow
        if (targetDate.getTime() <= now.getTime()) {
            targetDate.setDate(targetDate.getDate() + 1);
        }

        const delayMinutes = Math.max(1, Math.ceil((targetDate.getTime() - now.getTime()) / 60000));

        return {
            type: "time",
            delayMinutes,
            dueAt: targetDate.getTime(),
            label: `${this.t("at")} ${cleanedValue}`
        };
    }

    /**
     * Parse user-entered messages
     *
     * Splits on "---" (three or more dashes) to create message blocks
     *
     * @param {string} rawValue
     * @returns {Array<string>}
     */
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

    /**
     * Clean and trim whitespace from text
     *
     * @param {string} value
     * @returns {string}
     */
    cleanText(value) {
        return typeof value === "string" ? value.trim() : "";
    }

    /**
     * Normalize whitespace in text (collapse multiple spaces)
     *
     * @param {string} value
     * @returns {string}
     */
    normalizeText(value) {
        return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    }

    /**
     * Escape HTML special characters to prevent injection
     *
     * @param {string} value
     * @returns {string}
     */
    escapeHtml(value) {
        const text = value == null ? "" : String(value);
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    // ===== STORAGE & PERSISTENCE =====

    /**
     * Load scheduled messages from persistent storage
     *
     * @returns {Array<Object>}
     */
    loadQueue() {
        const stored = this.Data?.load?.(this.storageKey);
        if (!Array.isArray(stored)) return [];

        return stored
            .map(item => this.normalizeItem(item))
            .filter(Boolean);
    }

    /**
     * Save scheduled messages to persistent storage
     */
    saveQueue() {
        this.Data?.save?.(this.storageKey, this.queue);
    }

    /**
     * Save the current unscheduled modal message as a channel draft
     *
     * @param {HTMLElement} modal
     */
    saveDraftFromModal(modal) {
        if (this.editingScheduleId) return;

        const channelId = this.activeChannelId || this.getCurrentChannelId();
        if (!channelId) return;

        const messageField = modal.querySelector("#ms-message");
        const message = typeof messageField?.value === "string" ? messageField.value.trim() : "";

        if (message) {
            this.saveDraft(channelId, message);
            this.UI?.showToast?.("Draft saved.", { type: "success" });
        } else {
            this.clearDraft(channelId);
        }
    }

    /**
     * Load all message drafts
     *
     * @returns {Object}
     */
    loadDrafts() {
        const stored = this.Data?.load?.(this.draftStorageKey);
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};

        return Object.entries(stored).reduce((drafts, [channelId, draft]) => {
            const normalizedChannelId = typeof channelId === "string" ? channelId.trim() : "";
            const message = typeof draft?.message === "string" ? draft.message.trim() : "";
            if (normalizedChannelId && message) {
                drafts[normalizedChannelId] = {
                    message,
                    updatedAt: Number(draft.updatedAt) || Date.now()
                };
            }
            return drafts;
        }, {});
    }

    /**
     * Save all message drafts
     *
     * @param {Object} drafts
     */
    saveDrafts(drafts) {
        this.Data?.save?.(this.draftStorageKey, drafts && typeof drafts === "object" ? drafts : {});
    }

    /**
     * Get a channel draft
     *
     * @param {string} channelId
     * @returns {string}
     */
    getDraft(channelId) {
        const normalizedChannelId = typeof channelId === "string" ? channelId.trim() : "";
        if (!normalizedChannelId) return "";

        const draft = this.loadDrafts()[normalizedChannelId];
        return typeof draft?.message === "string" ? draft.message : "";
    }

    /**
     * Save a channel draft
     *
     * @param {string} channelId
     * @param {string} message
     */
    saveDraft(channelId, message) {
        const normalizedChannelId = typeof channelId === "string" ? channelId.trim() : "";
        const normalizedMessage = typeof message === "string" ? message.trim() : "";
        if (!normalizedChannelId || !normalizedMessage) return;

        const drafts = this.loadDrafts();
        drafts[normalizedChannelId] = {
            message: normalizedMessage,
            updatedAt: Date.now()
        };
        this.saveDrafts(drafts);
    }

    /**
     * Clear a channel draft
     *
     * @param {string} channelId
     */
    clearDraft(channelId) {
        const normalizedChannelId = typeof channelId === "string" ? channelId.trim() : "";
        if (!normalizedChannelId) return;

        const drafts = this.loadDrafts();
        if (!drafts[normalizedChannelId]) return;

        delete drafts[normalizedChannelId];
        this.saveDrafts(drafts);
    }

    /**
     * Validate and normalize a schedule item from storage
     *
     * @param {Object} item
     * @returns {Object|null}
     */
    normalizeItem(item) {
        if (!item || typeof item !== "object") return null;

        const channelId = typeof item.channelId === "string" ? item.channelId.trim() : "";
        const messages = Array.isArray(item.messages)
            ? item.messages.map(message => this.cleanText(message)).filter(Boolean)
            : [];
        const dueAt = Number(item.dueAt);

        if (!channelId || !messages.length || !Number.isFinite(dueAt) || dueAt <= 0) {
            return null;
        }

        return {
            id: typeof item.id === "string" ? item.id : this.createId(),
            channelId,
            messages,
            dueAt,
            scheduleLabel: typeof item.scheduleLabel === "string" ? item.scheduleLabel : "",
            scheduleInput: typeof item.scheduleInput === "string" ? item.scheduleInput : "",
            createdAt: Number(item.createdAt) || Date.now()
        };
    }

    // ===== TIMER MANAGEMENT =====

    /**
     * Restore timers for all pending scheduled messages
     *
     * Called on startup to reschedule messages
     */
    restoreTimers() {
        this.clearAllTimers();
        for (const item of this.queue) {
            this.scheduleTimer(item);
        }
    }

    /**
     * Cancel all pending timers
     */
    clearAllTimers() {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }

    /**
     * Schedule a timeout for a message
     *
     * @param {Object} item - Schedule item
     * @param {number} delayOverrideMs - Override delay in milliseconds (for retries)
     */
    scheduleTimer(item, delayOverrideMs = null) {
        if (!item || !item.id) {
            this.Logger?.warn?.("Cannot schedule timer: invalid item");
            return;
        }

        const delayMs = Number.isFinite(delayOverrideMs)
            ? Math.max(0, delayOverrideMs)
            : Math.max(0, item.dueAt - Date.now());

        try {
            const timerId = window.setTimeout(() => {
                void this.executeSchedule(item.id);
            }, delayMs);
            this.timers.set(item.id, timerId);
        } catch (error) {
            this.Logger?.error?.("Failed to schedule timer:", error);
        }
    }

    /**
     * Execute a scheduled message send
     *
     * @param {string} itemId
     */
    async executeSchedule(itemId) {
        const item = this.queue.find(entry => entry.id === itemId);
        if (!item) {
            this.Logger?.warn?.(`Schedule item not found: ${itemId}`);
            return;
        }

        this.clearScheduleTimer(itemId);

        try {
            const sent = await this.sendMessages(item.messages, item.channelId);

            if (sent) {
                this.Logger?.log?.(`Successfully sent scheduled messages for item: ${itemId}`);
                this.removeSchedule(itemId);
                return;
            }

            this.Logger?.warn?.(
                `Failed to send scheduled messages for item: ${itemId}; ` +
                `retrying in ${Math.round(this.retryDelayMs / 1000)}s`
            );
            this.UI?.showToast?.("Message not sent yet. Retrying shortly.", { type: "warning" });
            this.scheduleTimer(item, this.retryDelayMs);
        } catch (error) {
            this.Logger?.error?.("Error executing schedule:", error);
            this.UI?.showToast?.("Error while sending messages. Retrying shortly.", { type: "error" });
            this.scheduleTimer(item, this.retryDelayMs);
        }
    }

    /**
     * Remove a schedule from the queue
     *
     * @param {string} itemId
     */
    removeSchedule(itemId) {
        if (!itemId) {
            this.Logger?.warn?.("Cannot remove schedule: invalid itemId");
            return;
        }

        try {
            this.clearScheduleTimer(itemId);

            this.queue = this.queue.filter(item => item.id !== itemId);
            this.saveQueue();

            if (this.editingScheduleId === itemId) {
                this.editingScheduleId = "";
            }

            const modal = document.getElementById(this.modalId);
            if (modal) {
                this.refreshScheduledList(modal);
            }
        } catch (error) {
            this.Logger?.error?.("Error removing schedule:", error);
        }
    }

    // ===== MESSAGE SENDING =====

    /**
     * Send all messages in a schedule to a channel
     *
     * Handles message splitting for Discord's 2000 character limit
     *
     * @param {Array<string>} messages
     * @param {string} channelId
     * @returns {Promise<boolean>}
     */
    async sendMessages(messages, channelId) {
        if (!Array.isArray(messages) || !channelId) {
            this.Logger?.warn?.("Invalid messages or channelId");
            return false;
        }

        try {
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
        } catch (error) {
            this.Logger?.error?.("Error sending messages:", error);
            return false;
        }
    }

    /**
     * Split a message into chunks that fit Discord's 2000 character limit
     *
     * @param {string} message
     * @param {number} maxLength - Discord's character limit
     * @returns {Array<string>}
     */
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

    /**
     * Pause execution for a given number of milliseconds
     *
     * @param {number} delayMs
     * @returns {Promise<void>}
     */
    pause(delayMs) {
        return new Promise(resolve => window.setTimeout(resolve, delayMs));
    }

    /**
     * Get the Discord message actions module
     *
     * @returns {Object|null}
     */
    getMessageActions() {
        return this._messageActionsCache;
    }

    /**
     * Send a message via Discord's internal API
     *
     * @param {string} message - Message content
     * @param {string} channelId - Channel to send to
     * @returns {boolean}
     */
    sendMessageViaDiscordApi(message, channelId) {
        const actions = this.getMessageActions();
        if (!actions || typeof actions.sendMessage !== "function" || !channelId) {
            this.Logger?.warn?.("Cannot send message: missing actions or invalid channelId");
            return false;
        }

        try {
            actions.sendMessage(channelId, {
                content: message,
                tts: false,
                invalidEmojis: [],
                validNonShortcutEmojis: []
            }, true, {});

            return true;
        } catch (error) {
            this.Logger?.error?.("Failed to send message:", error);
            return false;
        }
    }

    // ===== CHANNEL INFORMATION =====

    /**
     * Get the currently selected channel ID
     *
     * @returns {string}
     */
    getCurrentChannelId() {
        try {
            const store = this._selectedChannelStoreCache;
            return store?.getChannelId?.() || store?.getCurrentlySelectedChannelId?.() || "";
        } catch (error) {
            this.Logger?.warn?.("Failed to get channel ID:", error);
            return "";
        }
    }

    /**
     * Get a label for a channel
     *
     * @param {string} channelId
     * @returns {string}
     */
    getChannelLabel(channelId) {
        if (!channelId) return "Unknown channel";

        try {
            const store = this._channelStoreCache;
            const channel = store?.getChannel?.(channelId);
            if (!channel) return `Channel ${channelId}`;

            const name = channel?.name ? `#${channel.name}` : "DM";
            return name;
        } catch (error) {
            this.Logger?.warn?.("Failed to get channel label:", error);
            return `Channel ${channelId}`;
        }
    }

    /**
     * Resolve the destination once for use in both the header and queued rows.
     * Existing schedules only store a channel ID, so names and avatars are resolved
     * live and stay current when a Discord user changes their profile.
     *
     * @param {string} channelId
     * @returns {{kind: "dm"|"channel"|"unknown", label: string, avatarUrl: string}}
     */
    getScheduledDestination(channelId) {
        if (!channelId) {
            return { kind: "unknown", label: this.t("recipientUnknown"), avatarUrl: "" };
        }

        try {
            const channel = this._channelStoreCache?.getChannel?.(channelId);
            if (!channel) {
                return { kind: "unknown", label: this.getChannelLabel(channelId), avatarUrl: "" };
            }

            const userStore = this._userStoreCache;
            const currentUserId = userStore?.getCurrentUser?.()?.id || "";
            const recipients = Array.isArray(channel.recipients)
                ? channel.recipients
                : Array.isArray(channel.rawRecipients)
                    ? channel.rawRecipients
                    : channel.getRecipientId?.()
                        ? [channel.getRecipientId()]
                        : [];
            const users = recipients.map(recipient => {
                const recipientId = typeof recipient === "string" ? recipient : recipient?.id;
                if (recipientId && recipientId === currentUserId) return null;
                return typeof recipient === "object" && recipient
                    ? recipient
                    : userStore?.getUser?.(recipientId) || null;
            }).filter(Boolean);
            const names = users.map(user =>
                this.cleanText(user.globalName || user.displayName || user.username || "")
            ).filter(Boolean);

            if (names.length) {
                return {
                    kind: "dm",
                    label: names.join(", "),
                    avatarUrl: names.length === 1 ? this.getUserAvatarUrl(users[0]) : ""
                };
            }

            if (channel.name) {
                return { kind: "channel", label: `#${channel.name}`, avatarUrl: "" };
            }

            return { kind: "unknown", label: this.t("recipientUnavailable"), avatarUrl: "" };
        } catch (error) {
            this.Logger?.warn?.("Failed to get scheduled-message recipient:", error);
            return { kind: "unknown", label: this.getChannelLabel(channelId), avatarUrl: "" };
        }
    }

    /**
     * @param {Object|null} user
     * @returns {string}
     */
    getUserAvatarUrl(user) {
        if (!user) return "";

        try {
            const directUrl = user.getAvatarURL?.();
            if (typeof directUrl === "string" && directUrl) return directUrl;
        } catch {
            // Fall through to Discord's CDN shape below.
        }

        if (user.id && user.avatar) {
            return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
        }

        return "";
    }

    /**
     * @param {string} channelId
     * @returns {string}
     */
    getScheduledRecipientLabel(channelId) {
        const destination = this.getScheduledDestination(channelId);
        if (destination.kind === "channel") {
            return `${this.t("channel")}: ${destination.label}`;
        }
        if (destination.kind === "dm") {
            return `${this.t("to")}: ${destination.label}`;
        }
        return destination.label;
    }
};

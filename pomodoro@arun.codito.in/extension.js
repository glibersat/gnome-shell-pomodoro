// A simple pomodoro timer for Gnome-shell
// Copyright (C) 2011 Arun Mahapatra, Gnome-shell pomodoro extension contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

const Lang = imports.lang;
const Mainloop = imports.mainloop;

const Clutter = imports.gi.Clutter;
const DBus = imports.dbus;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gio = imports.gi.Gio;
//const GConf = imports.gi.GConf;
const Pango = imports.gi.Pango;
const St = imports.gi.St;
const Util = imports.misc.util;
const GnomeSession = imports.misc.gnomeSession;
const ExtensionSystem = imports.ui.extensionSystem;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const ModalDialog = imports.ui.modalDialog;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const Gettext = imports.gettext.domain('gnome-shell-pomodoro');
const _ = Gettext.gettext;

let _useKeybinder = true;
try { const Keybinder = imports.gi.Keybinder; } catch (error) { _useKeybinder = false; }

//const SESSION_SCHEMA = 'org.gnome.desktop.session';
//const SESSION_IDLE_DELAY_KEY = 'idle-delay';

const SESSION_SCHEMA = 'org.gnome.desktop.session';
const SESSION_IDLE_DELAY_KEY = 'idle-delay';

const PAUSE_IDLE_DELAY = 60;

let _configVersion = "0.1";
let _configOptions = [ // [ <variable>, <config_category>, <actual_option>, <default_value> ]
    ["_pomodoroTime", "timer", "pomodoro_duration", 1500],
    ["_shortPauseTime", "timer", "short_pause_duration", 300],
    ["_longPauseTime", "timer", "long_pause_duration", 900],
    ["_showCountdownTimer", "ui", "show_countdown_timer", true],
    ["_showNotificationMessages", "ui", "show_messages", true],
    ["_showDialogMessages", "ui", "show_dialog_messages", true],
    ["_playSound", "ui", "play_sound", true],
    ["_keyToggleTimer", "ui", "key_toggle_timer", "<Ctrl><Alt>P"],
];

function Indicator() {
    this._init.apply(this, arguments);
}

const PomodoroNotifierIface = {
    name: 'org.gnome.shell.Pomodoro',
    methods: [{
	name: 'startWorksession',
	inSignature: 'i',
	outSignature: '',
    }, {
	name: 'endWorksession',
	inSignature: '',
	outSignature: '',
    }, {
	name: 'startBreak',
	inSignature: 'i',
	outSignature: '',
    }, {
	name: 'endBreak',
	inSignature: '',
	outSignature: '',
    }],

    signals: [{
	name: 'worksession_started',
	inSignature: 'i',
    }, {
	name: 'worksession_ended',
	inSignature: '',
    }, {
	name: 'break_started',
	inSignature: 'i',
    }, {
	name: 'break_ended',
	inSignature: '',
    }],
};

function PomodoroNotifierServer() {
    this._init();
}

PomodoroNotifierServer.prototype = {
    _init: function() {
	DBus.session.exportObject('/org/gnome/shell/Pomodoro', this);
	DBus.conformExport(PomodoroNotifierServer.prototype, PomodoroNotifierIface);
	DBus.session.acquire_name('org.gnome.shell.Pomodoro', 0, null, null);
    },
    //-- Methods --
    // Worksession
    startWorksession: function(message) {
	this._emitWorksession_start(message);
    },

    endWorksession: function(message) {
	this._emitWorksession_end(message);
    },

    // Breaks
    startBreak: function(message) {
	this._emitBreak_start(message);
    },

    endBreak: function(message) {
	this._emitBreak_end(message);
    },
    
    //-- Signals --
    // Worksession signals
    _emitWorksession_start: function(message) {
	DBus.session.emit_signal('/org/gnome/shell/Pomodoro',
				 'org.gnome.shell.Pomodoro',
				 'worksession_start', 'i',
				 [message]
				);
    },

    _emitWorksession_end: function(message) {
	DBus.session.emit_signal('/org/gnome/shell/Pomodoro',
				 'org.gnome.shell.Pomodoro',
				 'worksession_end', '',
				 [message]
				);
    },

    // Break signals
    _emitBreak_start: function(message) {
	DBus.session.emit_signal('/org/gnome/shell/Pomodoro',
				 'org.gnome.shell.Pomodoro',
				 'break_start', 'i',
				 [message]
				);
    },

    _emitBreak_end: function(message) {
	DBus.session.emit_signal('/org/gnome/shell/Pomodoro',
				 'org.gnome.shell.Pomodoro',
				 'break_end', '',
				 [message]
				);
    },

};

Indicator.prototype = {
    __proto__: PanelMenu.Button.prototype,

    _init: function() {
        PanelMenu.Button.prototype._init.call(this, St.Align.START);

	// DBus server
	this._dbus_server = new PomodoroNotifierServer();

        // Set default values of options, and then override from config file
        this._parseConfig();

        this._timer = new St.Label({ style_class: 'extension-pomodoro-label' });
        this._timeSpent = 0;
        this._minutes = 0;
        this._seconds = 0;
        this._isRunning = false;
        this._isPause = false;
        this._isIdle = false;
        this._pauseTime = this._longPauseTime;
        this._pauseCount = 0;                                   // Number of short pauses so far. Reset every 4 pauses.
        this._sessionCount = 0;                                 // Number of pomodoro sessions completed so far!
        this._labelMsg = new St.Label({ text: 'Stopped'});
        this._notification = null;
        this._dialog = null;
        this._notifiedIdle = false;
        this._timerSource = undefined;
        
        // Set default menu
        this._timer.clutter_text.set_line_wrap(false);
        this._timer.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        this.actor.add_actor(this._timer);

        // Set initial width of the timer label
        this._timer.connect('realize', Lang.bind(this, this._onTimerRealize));

        // Toggle timer state button
        this._timerToggle = new PopupMenu.PopupSwitchMenuItem(_("Pomodoro Timer"), false, { style_class: 'popup-subtitle-menu-item' });
        this._timerToggle.connect("toggled", Lang.bind(this, this._toggleTimerState));
        this.menu.addMenuItem(this._timerToggle);

        // Session count
        let item = new PopupMenu.PopupMenuItem(_("Collected"), { reactive: false });
        let bin = new St.Bin({ x_align: St.Align.END });
        this._sessionCountLabel = new St.Label({ text: _('None') }); // ● U+25CF BLACK CIRCLE //style_class: 'popup-inactive-menu-item' });
        bin.add_actor(this._sessionCountLabel);
        item.addActor(bin, { expand: true, span: -1, align: St.Align.END });
        this.menu.addMenuItem(item);

        // Separator
        let item = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(item);

        // Options SubMenu
        this._optionsMenu = new PopupMenu.PopupSubMenuMenuItem('Options');
        this.menu.addMenuItem(this._optionsMenu);
        // Add options to submenu
        this._buildOptionsMenu();

        // Register keybindings to toggle
        if (_useKeybinder) {
            Keybinder.init();
            Keybinder.bind(this._keyToggleTimer, Lang.bind(this, this._keyHandler), null);
        }

        // Dialog
        this._dialog = new ModalDialog.ModalDialog({ style_class: 'polkit-dialog' });

        let mainContentBox = new St.BoxLayout({ style_class: 'polkit-dialog-main-layout',
                                                vertical: false });
        this._dialog.contentLayout.add(mainContentBox,
                                              { x_fill: true,
                                                y_fill: true });

        //let icon = new St.Icon({ icon_name: 'pomodoro-symbolic' });
        //mainContentBox.add(icon,
        //                   { x_fill:  true,
        //                     y_fill:  false,
        //                     x_align: St.Align.END,
        //                     y_align: St.Align.START });

        let messageBox = new St.BoxLayout({ style_class: 'polkit-dialog-message-layout',
                                            vertical: true });
        mainContentBox.add(messageBox,
                           { y_align: St.Align.START });

        this._subjectLabel = new St.Label({ style_class: 'polkit-dialog-headline',
                                            text: _("Pomodoro Finished!") });

        messageBox.add(this._subjectLabel,
                       { y_fill:  false,
                         y_align: St.Align.START });

        this._descriptionLabel = new St.Label({ style_class: 'polkit-dialog-description',
                                                text: '' });
        this._descriptionLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._descriptionLabel.clutter_text.line_wrap = true;

        messageBox.add(this._descriptionLabel,
            { y_fill:  true,
              y_align: St.Align.START });

        this._dialog.contentLayout.add(this._descriptionLabel,
            { x_fill: true,
              y_fill: true });
        this._dialog.setButtons([
            { label: _("Hide"),
              action: Lang.bind(this, function(param) {
                        this._dialog.close();
                        this._notifyPomodoroEnd(_('Pomodoro finished, take a break!'), true);
                    }),
              key: Clutter.Escape 
            },
            { label: _("Start a new Pomodoro"),
              action: Lang.bind(this, function(param) {
                        this._startNewPomodoro();
                    }), 
            },]);

        // GNOME Session
        this._sessionSettings = new Gio.Settings({ schema: SESSION_SCHEMA });
        
        this._presence = new GnomeSession.Presence();
        this._presence.connect('StatusChanged',
                               Lang.bind(this, this._onSessionStatusChanged));

        // Draw the timer
        this._updateTimer();
    },

    // Add whatever options the timer needs to this submenu
    _buildOptionsMenu: function() {
        // Reset Counters Menu
        let resetButton =  new PopupMenu.PopupMenuItem(_('Reset Counts and Timer'));
        this._optionsMenu.menu.addMenuItem(resetButton);
        resetButton.actor.tooltip_text = "Click to reset session and break counts to zero";
        resetButton.connect('activate', Lang.bind(this, this._resetCount));

        let notificationSection = new PopupMenu.PopupMenuSection();
        this._optionsMenu.menu.addMenuItem(notificationSection);

        // Dialog Message toggle
        let showCountdownTimerToggle = new PopupMenu.PopupSwitchMenuItem
            (_("Show Countdown Timer"), this._showCountdownTimer);
        showCountdownTimerToggle.connect("toggled", Lang.bind(this, function() {
            this._showCountdownTimer = !(this._showCountdownTimer);
            this._onConfigUpdate(false);
        }));
        showCountdownTimerToggle.actor.tooltip_text = "Make the pomodoro timer count down to zero";
        notificationSection.addMenuItem(showCountdownTimerToggle);

        // ShowMessages option toggle
        let showNotificationMessagesToggle = new PopupMenu.PopupSwitchMenuItem(_("Show Notification Messages"), this._showNotificationMessages);
        showNotificationMessagesToggle.connect("toggled", Lang.bind(this, function() {
            this._showNotificationMessages = !(this._showNotificationMessages);
            this._onConfigUpdate(false);
        }));
        showNotificationMessagesToggle.actor.tooltip_text = "Show notification messages in the gnome-shell taskbar";
        notificationSection.addMenuItem(showNotificationMessagesToggle);

        // Dialog Message toggle
        let breakMessageToggle = new PopupMenu.PopupSwitchMenuItem
            (_("Show Dialog Messages"), this._showDialogMessages);
        breakMessageToggle.connect("toggled", Lang.bind(this, function() {
            this._showDialogMessages = !(this._showDialogMessages);
            this._onConfigUpdate(false);
        }));
        breakMessageToggle.actor.tooltip_text = "Show a dialog message at the end of pomodoro session"; 
        notificationSection.addMenuItem(breakMessageToggle);

        // Notify with a sound
        let playSoundToggle = new PopupMenu.PopupSwitchMenuItem
            (_("Sound Notifications"), this._playSound);
        playSoundToggle.connect("toggled", Lang.bind(this, function() {
            this._playSound = !(this._playSound);
            this._onConfigUpdate(false);
        }));
        playSoundToggle.actor.tooltip_text = "Play a sound at start of pomodoro session";
        this._optionsMenu.menu.addMenuItem(playSoundToggle);  

        // Pomodoro Duration section
        let timerLengthSection = new PopupMenu.PopupMenuSection();
        this._optionsMenu.menu.addMenuItem(timerLengthSection);

        let item = new PopupMenu.PopupMenuItem(_("Pomodoro Duration"), { reactive: false });
        this._pomodoroTimeLabel = new St.Label({ text: this._formatTime(this._pomodoroTime) });
        item.addActor(this._pomodoroTimeLabel, { align: St.Align.END });
        timerLengthSection.addMenuItem(item);

        this._pomodoroTimeSlider = new PopupMenu.PopupSliderMenuItem(this._pomodoroTime/3600);
        this._pomodoroTimeSlider.connect('value-changed', Lang.bind(this, function() {
            this._pomodoroTime = Math.ceil(Math.ceil(this._pomodoroTimeSlider._value * 3600)/60)*60;
            this._pomodoroTimeLabel.set_text(this._formatTime(this._pomodoroTime));
            this._onConfigUpdate(true);
        } ));
        timerLengthSection.addMenuItem(this._pomodoroTimeSlider);

        // Short Break Duration menu
        item = new PopupMenu.PopupMenuItem(_("Short Break Duration"), { reactive: false });
        this._sBreakTimeLabel = new St.Label({ text: this._formatTime(this._shortPauseTime) });
        item.addActor(this._sBreakTimeLabel, { align: St.Align.END });
        timerLengthSection.addMenuItem(item);

        this._sBreakTimeSlider = new PopupMenu.PopupSliderMenuItem(this._shortPauseTime/720);
        this._sBreakTimeSlider.connect('value-changed', Lang.bind(this, function() {
            this._shortPauseTime = Math.ceil(Math.ceil(this._sBreakTimeSlider._value * 720)/60)*60;
            this._sBreakTimeLabel.set_text(this._formatTime(this._shortPauseTime));
            this._onConfigUpdate(true);
        } ));
        timerLengthSection.addMenuItem(this._sBreakTimeSlider);

        // Long Break Duration menu
        item = new PopupMenu.PopupMenuItem(_("Long Break Duration"), { reactive: false });
        this._lBreakTimeLabel = new St.Label({ text: this._formatTime(this._longPauseTime) });
        item.addActor(this._lBreakTimeLabel, { align: St.Align.END });
        timerLengthSection.addMenuItem(item);

        this._lBreakTimeSlider = new PopupMenu.PopupSliderMenuItem(this._longPauseTime/2160);
        this._lBreakTimeSlider.connect('value-changed', Lang.bind(this, function() {
            this._longPauseTime = Math.ceil(Math.ceil(this._lBreakTimeSlider._value * 2160)/60)*60;
            this._lBreakTimeLabel.set_text(this._formatTime(this._longPauseTime));
            this._onConfigUpdate(true);
        } ));
        timerLengthSection.addMenuItem(this._lBreakTimeSlider);
    },

    // Handle the style related properties in the timer label. These properties are dependent on
    // font size/theme used by user, we need to calculate them during runtime
    _onTimerRealize: function(actor) {
        let context = actor.get_pango_context();
        let themeNode = actor.get_theme_node();
        let font = themeNode.get_font();
        let metrics = context.get_metrics(font, context.get_language());
        let digit_width = metrics.get_approximate_digit_width() / Pango.SCALE;
        let char_width = metrics.get_approximate_char_width() / Pango.SCALE;

        // predict by the number of characters and digits we have in the label
        actor.width = parseInt(digit_width * 6 + 2.4 * char_width);
    },

    // Handles option changes in the UI, saves the configuration
    // Set _validateTimer_ to true in case internal timer states and related options are changed
    _onConfigUpdate: function(validateTimer) {
        if (validateTimer == true)
            this._updateTimer();

        this._saveConfig();
    },

    _getSessionIdleDelay: function() {
        return this._sessionSettings.get_uint(SESSION_IDLE_DELAY_KEY);
    },
    
    _onSessionStatusChanged: function(presence, status) {
        this._isIdle = (status == GnomeSession.PresenceStatus.IDLE);
        if (this._isIdle)
            this._notifiedIdle = false;
        
        if (this._isRunning) {
            // Invalidate pomodoro if was idle from the start
            if (this._isIdle &&
                this._isPause == false &&
                this._timeSpent < this._getSessionIdleDelay()-1) // -1 second is to ignore clicks from timer switch
            {
                this._isPause = true;
                this._pauseCount -= 1;
                this._timeSpent = this._pauseTime + this._timeSpent;
                this._notifiedIdle = true;
            }
            this._updateTimer();
        }
    },

    // Skip break or reset current pomodoro
    _startNewPomodoro: function() {
        if (this._isPause)
            this._timeSpent = 99999;
        else
            this._timeSpent = 0;
        
        this._stopTimer();
        this._startTimer();
    },
    
    // Reset all counters and timers
    _resetCount: function() {
        this._timeSpent = 0;
        this._isPause = false;
        this._sessionCount = 0;
        this._pauseCount = 0;

        if (this._isRunning) {
            this._stopTimer();
            this._startTimer();
        }else{
            this._updateTimer();
            this._updateSessionCount();
        }
        return false;
    },

    _createNotificationSource: function() {
        let source = new MessageTray.SystemNotificationSource();
        source.setTitle(_('Pomodoro Timer'));
        Main.messageTray.add(source);
        return source;
    },

    _closeNotification: function() {
        if (this._notification != null) {
            this._notification.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
            this._notification = null;        
        }
        if (this._dialog != null)
            this._dialog.close();
    },

    // Notify user of changes
    _notifyPomodoroStart: function(text, force) {
        this._closeNotification();

        if (this._showNotificationMessages || force) {
            let source = this._createNotificationSource ();
            this._notification = new MessageTray.Notification(source, text);
            this._notification.setTransient(true);
            
            source.notify(this._notification);
        }        

        this._playNotificationSound();
    },
    
    // Notify user of changes
    _notifyPomodoroEnd: function(text, hideDialog) {
        this._closeNotification();

        if (this._showDialogMessages && hideDialog != true) {
            this._dialog.open();
        }
        else{
            if (this._showNotificationMessages || hideDialog) {
                let source = this._createNotificationSource ();
                this._notification = new MessageTray.Notification(source, text, null);
                this._notification.setResident(true);
                this._notification.addButton(1, _('Start a new Pomodoro'));
                this._notification.connect('action-invoked', Lang.bind(this, function(param) {
                            this._startNewPomodoro();
                        })
                    );
                source.notify(this._notification);
            }
        }
    },

    // Plays a notification sound
    _playNotificationSound: function() {
        if (this._playSound) {
            let extension = ExtensionSystem.extensionMeta["pomodoro@arun.codito.in"];
            let uri = GLib.filename_to_uri(extension.path + "/bell.wav", null);
            
            try {
                let gstPath = "gst-launch";
                if (GLib.find_program_in_path(gstPath) == null)
                    gstPath = GLib.find_program_in_path("gst-launch-0.10");
                if (gstPath != null)
                    Util.trySpawnCommandLine(gstPath + " --quiet playbin2 uri=" +
                            GLib.shell_quote(uri));
                else
                    this._playSound = false;
            } catch (err) {
                global.logError("Pomodoro: Error playing a sound: " + err.message);
                this._playSound = false;
            } finally {
                if (this._playSound == false)
                    global.logError("Pomodoro: Disabled sound.");
            }
        }
    },

    // Toggle timer state
    _toggleTimerState: function(item) {
        this._timeSpent = 0;
        this._minutes = 0;
        this._seconds = 0;
        this._isPause = false;
        
        if (item.state)
            this._startTimer();
        else
            this._stopTimer();        
    },
    
    _startTimer: function() {
        if (this._timerSource == undefined) {
            this._timerSource = Mainloop.timeout_add_seconds(1, Lang.bind(this, this._refreshTimer));
            this._isRunning = true;

	    // Trigger dbus signals
	    if ( this._isPause )
		this._dbus_server._emitBreak_start(this._menutes * 60 + this._seconds);
	    else
		this._dbus_server._emitWorksession_start(this._minutes * 60 + this._seconds);


            this._updateTimer();
            this._updateSessionCount();
        }
    },

    _stopTimer: function() {
        if (this._timerSource != undefined) {
            GLib.source_remove(this._timerSource);
            this._timerSource = undefined;
            this._isRunning = false;	    
            this._updateTimer();
            this._updateSessionCount();
            this._closeNotification();
        }
    },

    // Increment timeSpent and call functions to check timer states and update ui_timer    
    _refreshTimer: function() {
        if (this._isRunning) {
            this._timeSpent += 1;
            this._checkTimerState();
            this._updateTimer();
            return true;
        }
        return false;
    },


    // Checks if timer needs to change state
    _checkTimerState: function() {
        if (this._isRunning) {
            // Check if a pause is running..
            if (this._isPause == true) {
                // Check if the pause is over
                if (this._timeSpent >= this._pauseTime && this._isIdle != true) {
                    this._timeSpent = 0;
                    this._isPause = false;
                    if (this._notifiedIdle == false)
                        this._notifyPomodoroStart(_('Pause finished, a new pomodoro is starting!'));
                    this._updateSessionCount();
                }
                else if (this._timeSpent >= this._pauseTime && this._isIdle && this._notifiedIdle != true) {
                    this._notifiedIdle = true;
                    this._notifyPomodoroStart(_('Pause finished, a new pomodoro is starting!'));
                }
                else{
                    if (this._pauseCount == 0)
                        this._pauseTime = this._longPauseTime;
                    else
                        this._pauseTime = this._shortPauseTime;
                }
            }
            // ..or if a pomodoro is running and a pause is needed :)
            else if (this._timeSpent >= this._pomodoroTime) {
                this._pauseCount += 1;
                this._pauseTime = this._shortPauseTime;

                // Check if it's time of a longer pause
                if (this._pauseCount == 4) {
                    this._pauseCount = 0;
                    this._pauseTime = this._longPauseTime;
                    this._notifyPomodoroEnd(_('4th pomodoro in a row finished, starting a long pause...'));
                }
                else {
                    this._notifyPomodoroEnd(_('Pomodoro finished, take a break!'));
                }

                this._timeSpent = 0;
                this._minutes = 0;
                this._seconds = 0;
                this._sessionCount += 1;
                this._isPause = true;
                this._updateSessionCount();

	    }
	}
    },

    _updateSessionCount: function() {
        let text = '';

        if (this._sessionCount == 0 && this._isRunning == false) {
            text = _('None');
        }
        else {
            if (this._isPause || this._isRunning == false)
                text = Array((this._sessionCount-1) % 4 + 2).join('\u25cf'); // ● U+25CF BLACK CIRCLE            
            else
                text = Array(this._sessionCount % 4 + 1).join('\u25cf') + '\u25d6'; // ◖ U+25D6 LEFT HALF BLACK CIRCLE
        }
        this._sessionCountLabel.set_text(text);
    },

    // Update timer_ui
    _updateTimer: function() {
        this._checkTimerState();

        if (this._isRunning) {
            let seconds = this._timeSpent;
            if (this._showCountdownTimer == true)
                seconds = Math.max((this._isPause ? this._pauseTime : this._pomodoroTime) - this._timeSpent, 0);
            
            this._minutes = parseInt(seconds / 60);
            this._seconds = parseInt(seconds % 60);

            timer_text = "[%02d] %02d:%02d".format(this._sessionCount, this._minutes, this._seconds);
            this._timer.set_text(timer_text);

            if (this._isPause && this._showDialogMessages)
            {
                seconds = this._pauseTime - this._timeSpent;
                if (seconds < 47)
                    this._descriptionLabel.text = _("Take a break! You have %d seconds\n").format(Math.round(seconds / 5) * 5);
                else
                    this._descriptionLabel.text = _("Take a break! You have %d minutes\n").format(Math.round(seconds / 60));
            }
        }
        else{
            timer_text = "[%02d] 00:00".format(this._sessionCount);
            this._timer.set_text(timer_text);
        }
    },


    // Format absolute time in seconds as "Xm Ys"
    _formatTime: function(abs) {
        let minutes = Math.floor(abs/60);
        let seconds = abs - minutes*60;
        return _("%d minutes").format(minutes);
    },

    _keyHandler: function(keystring, data) {
        if (keystring == this._keyToggleTimer) {
            this._toggleTimerState(null);
            this._timerToggle.setToggleState(this._isRunning);
        }
    },
    
    _parseConfig: function() {
        // Set the default values
        for (let i = 0; i < _configOptions.length; i++)
            this[_configOptions[i][0]] = _configOptions[i][3];

	// Search for configuration files first in system config dirs and after in the user dir
	let _configDirs = [GLib.get_system_config_dirs(), GLib.get_user_config_dir()];
	for(var i = 0; i < _configDirs.length; i++) {
            let _configFile = _configDirs[i] + "/gnome-shell-pomodoro/gnome_shell_pomodoro.json";

            if (GLib.file_test(_configFile, GLib.FileTest.EXISTS)) {
		let filedata = null;

		try {
                    filedata = GLib.file_get_contents(_configFile, null, 0);
                    global.log("Pomodoro: Using config file = " + _configFile);

                    let jsondata = JSON.parse(filedata[1]);
                    let parserVersion = null;
                    if (jsondata.hasOwnProperty("version"))
			parserVersion = jsondata.version;
                    else
			throw "Parser version not defined";

                    for (let i = 0; i < _configOptions.length; i++) {
			let option = _configOptions[i];
			if (jsondata.hasOwnProperty(option[1]) && jsondata[option[1]].hasOwnProperty(option[2])) {
                            // The option "category" and the actual option is defined in config file,
                            // override it!
                            this[option[0]] = jsondata[option[1]][option[2]];
			}
                    }
		}
		catch (e) {
                    global.logError("Pomodoro: Error reading config file " + _configFile + ", error = " + e);
		}
		finally {
                    filedata = null;
		}
            }
	}
    },


    _saveConfig: function() {
        let _configDir = GLib.get_user_config_dir() + "/gnome-shell-pomodoro";
        let _configFile = _configDir + "/gnome_shell_pomodoro.json";
        let filedata = null;
        let jsondata = {};

        if (GLib.file_test(_configDir, GLib.FileTest.EXISTS | GLib.FileTest.IS_DIR) == false &&
                GLib.mkdir_with_parents(_configDir, 0x2141) != 0) { // 0755 base 8 = 0x2141 base 6
                    global.logError("Pomodoro: Failed to create configuration directory. Path = " +
                            _configDir + ". Configuration will not be saved.");
                }

        try {
            jsondata["version"] = _configVersion;
            for (let i = 0; i < _configOptions.length; i++) {
                let option = _configOptions[i];
                // Insert the option "category", if it's undefined
                if (jsondata.hasOwnProperty(option[1]) == false) {
                    jsondata[option[1]] = {};
                }

                // Update the option key/value pairs
                jsondata[option[1]][option[2]] = this[option[0]];
            }
            filedata = JSON.stringify(jsondata, null, "  ");
            GLib.file_set_contents(_configFile, filedata, filedata.length);
        }
        catch (e) {
            global.logError("Pomodoro: Error writing config file = " + e);
        }
        finally {
            jsondata = null;
            filedata = null;
        }
        global.log("Pomodoro: Updated config file = " + _configFile);
    }
};

// Extension initialization code
function init(metadata) {
    //imports.gettext.bindtextdomain('gnome-shell-pomodoro', metadata.localedir);
}

let _indicator;

function enable() {
    if (_indicator == null) {
        _indicator = new Indicator;
        Main.panel.addToStatusArea('pomodoro', _indicator);
    }
}

function disable() {
    if (_indicator != null) {
        _indicator.destroy();
        _indicator = null;
    }
}

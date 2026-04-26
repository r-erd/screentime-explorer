/// catalogue.rs — built-in app → category mappings.
///
/// Seeded into `app_categories` with INSERT OR IGNORE on every startup, so
/// user overrides (stored as regular rows in the same table) are never lost.

pub fn entries() -> &'static [(&'static str, &'static str)] {
    &[
        // ── Browser ──────────────────────────────────────────────────────────
        ("com.apple.mobilesafari",              "Browser"),
        ("com.apple.Safari",                    "Browser"),
        ("com.google.chrome.ios",               "Browser"),
        ("com.google.Chrome",                   "Browser"),
        ("org.mozilla.ios.Firefox",             "Browser"),
        ("org.mozilla.firefox",                 "Browser"),
        ("com.microsoft.msedge",                "Browser"),
        ("com.microsoft.msedge.ios",            "Browser"),
        ("company.thebrowser.Browser",          "Browser"),  // Arc
        ("com.brave.ios.browser",               "Browser"),
        ("com.brave.Browser",                   "Browser"),
        ("com.opera.mini.native",               "Browser"),
        ("com.duckduckgo.mobile.ios",           "Browser"),
        ("com.duckduckgo.macos.browser",        "Browser"),
        ("com.vivaldi.browser",                 "Browser"),
        ("com.kagi.kagimacOS",                  "Browser"),  // Kagi

        // ── Social ───────────────────────────────────────────────────────────
        ("com.atebits.Tweetie2",                "Social"),   // X / Twitter iOS
        ("com.twitter.twitter-mac",             "Social"),   // X / Twitter macOS
        ("com.burbn.instagram",                 "Social"),
        ("com.facebook.Facebook",               "Social"),
        ("com.facebook.Messenger",              "Social"),
        ("com.zhiliaoapp.musically",            "Social"),   // TikTok iOS
        ("com.ss.iphone.ugc.Bytedance",         "Social"),   // TikTok alt
        ("com.reddit.Reddit",                   "Social"),
        ("com.reddit.reddit",                   "Social"),
        ("com.linkedin.LinkedIn",               "Social"),
        ("com.toyopagroup.picaboo",             "Social"),   // Snapchat
        ("com.burbn.barcelona",                 "Social"),   // Threads
        ("AlexisBarreyat.BeReal",               "Social"),
        ("com.pinterest.Pinterest",             "Social"),
        ("com.tumblr.tumblr",                   "Social"),
        ("com.nytimes.NYTimes",                 "Social"),   // NYT (often social reading)
        ("jp.naver.line.mac",                   "Social"),   // LINE
        ("jp.naver.line",                       "Social"),
        ("com.weibo.app",                       "Social"),
        ("com.tencent.xin",                     "Social"),   // WeChat iOS
        ("com.tencent.xinWeChat",               "Social"),   // WeChat macOS
        ("com.reddit.alienblue",                "Social"),   // Alien Blue (old)
        ("com.mlemapp.Mlem",                    "Social"),   // Lemmy client
        ("org.joinmastodon.app",                "Social"),
        ("com.tapbots.Ivory",                   "Social"),   // Mastodon client
        ("com.shinyfrog.Ivory",                 "Social"),
        ("io.gitlab.thermion.Thermion",         "Social"),

        // ── Communication ────────────────────────────────────────────────────
        ("com.apple.MobileSMS",                 "Communication"),  // Messages
        ("com.apple.iChat",                     "Communication"),  // Messages macOS
        ("com.apple.facetime",                  "Communication"),
        ("net.whatsapp.WhatsApp",               "Communication"),
        ("net.whatsapp.WhatsAppMac",            "Communication"),
        ("ph.telegra.Telegraph",                "Communication"),  // Telegram iOS
        ("ru.keepcoder.Telegram",               "Communication"),  // Telegram macOS
        ("org.whispersystems.signal",           "Communication"),
        ("com.hammerandchisel.discord",         "Communication"),  // Discord iOS
        ("com.hnc.Discord",                     "Communication"),  // Discord macOS
        ("us.zoom.videomeetings",               "Communication"),
        ("us.zoom.xos",                         "Communication"),  // Zoom macOS
        ("com.microsoft.teams",                 "Communication"),
        ("com.microsoft.skype.SkypeRTApp",      "Communication"),
        ("com.apple.mobilemail",                "Communication"),
        ("com.apple.Mail",                      "Communication"),
        ("com.google.Gmail",                    "Communication"),
        ("com.microsoft.Office.Outlook",        "Communication"),
        ("com.readdle.smartemail",              "Communication"),  // Spark
        ("com.tinyspeck.chatlyio",              "Communication"),  // Slack iOS
        ("com.tinyspeck.slackmacgap",           "Communication"),  // Slack macOS
        ("com.apple.mobilephone",               "Communication"),
        ("com.apple.InCallService",             "Communication"),
        ("com.viber.iphone",                    "Communication"),  // Viber
        ("com.airmail.iphone",                  "Communication"),
        ("com.mimestream.Mimestream",           "Communication"),
        ("com.superhuman.Superhuman",           "Communication"),
        ("com.loom.desktop",                    "Communication"),

        // ── Productivity ─────────────────────────────────────────────────────
        ("notion.id",                           "Productivity"),
        ("md.obsidian",                         "Productivity"),
        ("com.culturedcode.ThingsiPhone",       "Productivity"),
        ("com.culturedcode.Things3",            "Productivity"),
        ("com.omnigroup.OmniFocus4",            "Productivity"),
        ("com.omnigroup.OmniFocus4.MacAppStore","Productivity"),
        ("com.todoist.ios",                     "Productivity"),
        ("com.todoist.mac.Todoist",             "Productivity"),
        ("com.apple.reminders",                 "Productivity"),
        ("com.apple.mobilecal",                 "Productivity"),
        ("com.apple.iCal",                      "Productivity"),
        ("com.apple.mobilenotes",               "Productivity"),
        ("com.apple.Notes",                     "Productivity"),
        ("com.apple.Pages",                     "Productivity"),
        ("com.apple.iWork.Pages",               "Productivity"),
        ("com.apple.Numbers",                   "Productivity"),
        ("com.apple.iWork.Numbers",             "Productivity"),
        ("com.apple.Keynote",                   "Productivity"),
        ("com.apple.iWork.Keynote",             "Productivity"),
        ("com.microsoft.Office.Word",           "Productivity"),
        ("com.microsoft.Office.Excel",          "Productivity"),
        ("com.microsoft.Office.PowerPoint",     "Productivity"),
        ("com.agiletortoise.Drafts5",           "Productivity"),
        ("net.shinyfrog.bear",                  "Productivity"),
        ("com.gingerlabs.notability",           "Productivity"),
        ("com.goodnotesapp.x",                  "Productivity"),
        ("com.adobe.Reader",                    "Productivity"),
        ("com.readdle.PDFExpert-iOS",           "Productivity"),
        ("com.flexibits.fantastical2.iphone",   "Productivity"),
        ("com.flexibits.fantastical2.mac",      "Productivity"),
        ("com.mollysoftware.Structured",        "Productivity"),
        ("com.craft.craftdocs",                 "Productivity"),
        ("com.logseq.logseq",                   "Productivity"),

        // ── Entertainment ────────────────────────────────────────────────────
        ("com.google.ios.youtube",              "Entertainment"),
        ("com.google.ios.youtube.music",        "Entertainment"),
        ("com.netflix.Netflix",                 "Entertainment"),
        ("com.hulu.plus",                       "Entertainment"),
        ("com.disney.disneyplus",               "Entertainment"),
        ("com.spotify.client",                  "Entertainment"),
        ("com.apple.Music",                     "Entertainment"),
        ("com.apple.podcasts",                  "Entertainment"),
        ("firecore.infuse7",                    "Entertainment"),  // Infuse
        ("org.videolan.vlc",                    "Entertainment"),
        ("com.plexapp.plex",                    "Entertainment"),
        ("com.apple.tv",                        "Entertainment"),
        ("com.amazon.aiv.AIVApp",               "Entertainment"),  // Prime Video
        ("tv.twitch.live.video",                "Entertainment"),
        ("com.hbo.hbonow",                      "Entertainment"),  // Max
        ("com.audible.iphone",                  "Entertainment"),
        ("com.apple.iBooks",                    "Entertainment"),
        ("com.amazon.Lassen",                   "Entertainment"),  // Kindle iOS
        ("com.amazon.Kindle",                   "Entertainment"),
        ("com.soundcloud.SoundCloud",           "Entertainment"),
        ("com.tidal.tidal",                     "Entertainment"),
        ("com.deezer.Deezer",                   "Entertainment"),
        ("com.pandora.pandora",                 "Entertainment"),
        ("com.crunchyroll.iphone",              "Entertainment"),
        ("com.mubi.MUBI",                       "Entertainment"),
        ("com.apple.AppStore",                  "Entertainment"),  // browsing App Store

        // ── Developer Tools ──────────────────────────────────────────────────
        ("com.apple.dt.Xcode",                  "Developer Tools"),
        ("com.microsoft.VSCode",                "Developer Tools"),
        ("com.microsoft.VSCodeInsiders",        "Developer Tools"),
        ("com.apple.Terminal",                  "Developer Tools"),
        ("com.googlecode.iterm2",               "Developer Tools"),
        ("dev.warp.Warp-Stable",                "Developer Tools"),
        ("com.apple.iphonesimulator",           "Developer Tools"),
        ("com.apple.dt.instruments",            "Developer Tools"),
        ("com.github.stormbreaker.prod",        "Developer Tools"),  // GitHub iOS
        ("com.github.GitHubMacDesktop",         "Developer Tools"),  // GitHub macOS
        ("com.axosoft.gitkraken",               "Developer Tools"),
        ("com.fournova.Tower3",                 "Developer Tools"),
        ("com.DanPristupov.Fork",               "Developer Tools"),
        ("com.postmanlabs.mac",                 "Developer Tools"),
        ("com.proxyman.NSProxy",                "Developer Tools"),
        ("com.tinyapp.TablePlus",               "Developer Tools"),
        ("com.jetbrains.datagrip",              "Developer Tools"),
        ("com.jetbrains.intellij",              "Developer Tools"),
        ("com.jetbrains.pycharm",               "Developer Tools"),
        ("com.jetbrains.webstorm",              "Developer Tools"),
        ("com.jetbrains.rubymine",              "Developer Tools"),
        ("com.jetbrains.goland",                "Developer Tools"),
        ("com.google.android.studio",           "Developer Tools"),
        ("com.docker.docker",                   "Developer Tools"),
        ("com.todesktop.230313mzl4w4u92",       "Developer Tools"),  // Cursor
        ("io.cursor.Cursor",                    "Developer Tools"),
        ("com.figma.Desktop",                   "Developer Tools"),
        ("com.bohemiancoding.sketch3",          "Developer Tools"),
        ("com.adobe.xd",                        "Developer Tools"),
        ("com.zeplin.app",                      "Developer Tools"),
        ("com.balsamiq.mockups3",               "Developer Tools"),
        ("com.charlesproxy.charles",            "Developer Tools"),
        ("com.httpie.mac",                      "Developer Tools"),
        ("com.luckymarmot.Paw",                 "Developer Tools"),
        ("com.raycast.macos",                   "Developer Tools"),
        ("io.appsmith.Appsmith",                "Developer Tools"),
        ("com.rverb.codeshot",                  "Developer Tools"),

        // ── Health & Fitness ─────────────────────────────────────────────────
        ("com.apple.Health",                    "Health & Fitness"),
        ("com.apple.Fitness",                   "Health & Fitness"),
        ("com.strava.stravaride",               "Health & Fitness"),
        ("com.myfitnesspal.mfp",                "Health & Fitness"),
        ("com.getsomeheadspace.Headspace",      "Health & Fitness"),
        ("com.calm.ios",                        "Health & Fitness"),
        ("com.calm.desktop",                    "Health & Fitness"),
        ("com.northcube.sleepcycle",            "Health & Fitness"),
        ("com.nike.nikeplus-gps",               "Health & Fitness"),
        ("com.garmin.connect.mobile",           "Health & Fitness"),
        ("ouraring.app",                        "Health & Fitness"),
        ("com.whoop.ios",                       "Health & Fitness"),
        ("com.peloton.Peloton",                 "Health & Fitness"),
        ("com.apple.workout",                   "Health & Fitness"),
        ("com.fitbit.FitbitMobile",             "Health & Fitness"),
        ("com.adidas.runtastic",                "Health & Fitness"),  // Runtastic
        ("com.noom.Noom",                       "Health & Fitness"),
        ("com.wearehinge.app",                  "Health & Fitness"),  // Hinge (debatable)

        // ── Games ────────────────────────────────────────────────────────────
        ("com.king.candycrushsaga",             "Games"),
        ("com.supercell.magic",                 "Games"),   // Clash of Clans
        ("com.supercell.clashofclans",          "Games"),
        ("com.innersloth.amongus",              "Games"),
        ("com.nianticlabs.pokemongo",           "Games"),
        ("com.activision.callofduty.shooter",   "Games"),
        ("com.mojang.minecraftpe",              "Games"),
        ("com.roblox.robloxmobile",             "Games"),
        ("com.miHoYo.GenshinImpact",            "Games"),
        ("com.epicgames.fortnite",              "Games"),
        ("com.valvesoftware.steam.mobile",      "Games"),
        ("com.playstation.RemotePlay",          "Games"),
        ("com.microsoft.xcloud",                "Games"),  // Xbox Cloud
        ("com.nvidia.geforcenow",               "Games"),
        ("com.ea.game.nfs14_row",               "Games"),
        ("com.2k.nba2k20",                      "Games"),
        ("com.lichess.app",                     "Games"),  // Chess
        ("org.chess.Chess",                     "Games"),
        ("com.chess.lite",                      "Games"),

        // ── Utilities ────────────────────────────────────────────────────────
        ("com.apple.finder",                    "Utilities"),
        ("com.apple.Preferences",               "Utilities"),
        ("com.apple.systempreferences",         "Utilities"),
        ("com.apple.ActivityMonitor",           "Utilities"),
        ("com.apple.DiskUtility",               "Utilities"),
        ("com.apple.mobileslideshow",           "Utilities"),  // Photos iOS
        ("com.apple.Photos",                    "Utilities"),
        ("com.apple.Preview",                   "Utilities"),
        ("com.apple.TextEdit",                  "Utilities"),
        ("com.apple.calculator",                "Utilities"),
        ("com.apple.Maps",                      "Utilities"),
        ("com.apple.clock",                     "Utilities"),
        ("com.apple.weather",                   "Utilities"),
        ("com.apple.MobileAddressBook",         "Utilities"),
        ("com.apple.Contacts",                  "Utilities"),
        ("com.apple.shortcuts",                 "Utilities"),
        ("com.apple.DocumentsApp",              "Utilities"),  // Files
        ("com.agilebits.onepassword-ios",       "Utilities"),
        ("com.agilebits.onepassword-osx",       "Utilities"),  // 1Password macOS
        ("com.bitwarden.mobile",                "Utilities"),
        ("com.getdropbox.Dropbox",              "Utilities"),
        ("com.google.Drive",                    "Utilities"),
        ("com.nordvpn.NordVPN",                 "Utilities"),
        ("com.runningwithcrayons.Alfred",       "Utilities"),
        ("com.apple.FaceTime",                  "Utilities"),
        ("com.apple.Home",                      "Utilities"),
        ("com.apple.TV",                        "Utilities"),
        ("net.tunnelblick.tunnelblick",         "Utilities"),
        ("com.expressvpn.ExpressVPN",           "Utilities"),
        ("com.google.Translate",                "Utilities"),
        ("com.apple.Translate",                 "Utilities"),
        ("com.apple.Screenshot",                "Utilities"),
        ("com.apple.Automator",                 "Utilities"),
        ("com.apple.ScriptEditor",              "Utilities"),
        ("com.apple.Console",                   "Utilities"),
        ("com.apple.keychainaccess",            "Utilities"),
        ("com.apple.ColorSync",                 "Utilities"),
        ("com.apple.DigitalColorMeter",         "Utilities"),
        ("com.apple.print.PrintCenter",         "Utilities"),
    ]
}

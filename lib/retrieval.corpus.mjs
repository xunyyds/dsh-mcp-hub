// 检索内核的离线评测语料：目录 + 任务句式。
//
// 为什么要有这个文件：改检索打分最容易犯的错是「凭一条查询手感调参」。
// 旧实现就是被一条手感说服的——`screenshot` 能命中 Screenshot，看起来没问题，
// 而中文查询恒等于零命中这件事没有任何测试会红。等用户报「中文搜不到工具」，
// 现场已经烧掉了一整轮对话：模型先抓到 compare_source_to_bundle（描述散文里
// 恰好带 so），照着调用失败，再换词重试。
//
// 所以这里固定两样东西：
//   1) CATALOG —— 一份贴着本机真实工具放的目录快照（mobile / rea / windows /
//      openchatcut）。检索质量的评测必须对着一份**不随机器变化**的目录跑，
//      否则同一条查询在今天和明天得分不同，门禁就成了噪声；
//   2) CORPUS —— 50-100 条任务口语句式，中英各半。写法刻意贴真人说法
//      （「进游戏卡死了，把崩溃栈拿出来」而不是「查询 crash 工具」），
//      因为要测的是「用户这么说话时能不能找到工具」，不是「词表对不对」。
//
// 条目形状与 lib/gateway.js 的 entryOf 产出保持一致（name/server/tool/summary），
// 额外带上 parameters：真实目录条目目前不带参数，但分发到 rankEntries 的
// entry 只要带了它，参数名就会进入文档——这段通路要在这里被真跑到，
// 否则等哪天 entryOf 补上 parameters，才发现参数桥接是死代码。

// [裸工具名, 一句话摘要, 参数名列表]
const MOBILE_TOOLS = [
  ["mobile_list_available_devices", "List all available devices, both physical devices and simulators.", []],
  ["mobile_list_apps", "List apps installed on the device.", ["device"]],
  ["mobile_get_foreground_app", "Get the app currently in the foreground.", ["device"]],
  ["mobile_launch_app", "Launch an app by package name on the device.", ["device", "package"]],
  ["mobile_terminate_app", "Terminate a running app on the device.", ["device", "package"]],
  ["mobile_install_app", "Install an app package such as an apk on the device.", ["device", "path"]],
  ["mobile_uninstall_app", "Uninstall an app from the device.", ["device", "package"]],
  ["mobile_get_screen_size", "Get the screen size of the device.", ["device"]],
  ["mobile_click_on_screen_at_coordinates", "Click on the screen, either at x,y coordinates or on an element by its ref.", ["device", "x", "y"]],
  ["mobile_double_tap_on_screen", "Double tap on the screen at x,y coordinates.", ["device", "x", "y"]],
  ["mobile_long_press_on_screen_at_coordinates", "Long press on the screen at x,y coordinates.", ["device", "x", "y"]],
  ["mobile_list_elements_on_screen", "List the elements on screen with their coordinates and labels.", ["device"]],
  ["mobile_press_button", "Press a hardware button on the device, such as home or back.", ["device", "button"]],
  ["mobile_open_url", "Open a url in the device browser.", ["device", "url"]],
  ["mobile_swipe_on_screen", "Swipe on the screen from one direction to another.", ["device", "direction"]],
  ["mobile_type_keys", "Type text into the focused field on the device.", ["device", "text"]],
  ["mobile_save_screenshot", "Save a screenshot of the device screen to a file.", ["device", "path"]],
  ["mobile_take_screenshot", "Take a screenshot of the device screen.", ["device"]],
  ["mobile_set_orientation", "Set the screen orientation of the device.", ["device", "orientation"]],
  ["mobile_fold_device", "Fold or unfold a foldable device.", ["device"]],
  ["mobile_set_location", "Set the simulated gps location of the device.", ["device", "latitude", "longitude"]],
  ["mobile_clipboard", "Read or write the clipboard of the device.", ["device", "text"]],
  ["mobile_get_device_logs", "Read the logcat logs of the device.", ["device"]],
  ["mobile_get_orientation", "Get the current screen orientation of the device.", ["device"]],
  ["mobile_start_screen_recording", "Start recording a video of the device screen.", ["device"]],
  ["mobile_stop_screen_recording", "Stop the screen recording and save the video.", ["device", "path"]],
  ["mobile_list_crashes", "List crash reports collected on the device.", ["device"]],
  ["mobile_get_crash", "Get one crash report with its stack trace by id.", ["device", "id"]],
  ["mobile_batch_commands", "Run several device commands in one batch.", ["commands"]],
  ["mobile_login_to_cloud_provider", "Log in to the remote cloud device provider.", ["provider"]],
  ["mobile_list_remote_devices", "List remote cloud devices available to allocate.", []],
  ["mobile_allocate_remote_device", "Allocate a remote cloud device for this session.", []],
  ["mobile_release_remote_device", "Release the allocated remote device back to the pool.", ["device"]]
];

const REA_TOOLS = [
  ["open_binary", "Open a local binary for analysis.", ["path"]],
  ["disassemble_function", "Disassemble one function into assembly instructions.", ["address"]],
  ["list_symbols", "List the symbols of the loaded binary.", []],
  ["resolve_containing_procedure", "Resolve the procedure that contains an address.", ["address"]],
  ["compare_source_to_bundle", "Compare source files to a bundled firmware image.", ["source", "bundle"]],
  ["decompile_function", "Decompile one function into pseudocode.", ["address"]],
  ["list_strings", "List the strings found in the binary.", []],
  ["xrefs_to", "List cross references to an address or symbol.", ["address"]],
  ["analyze_function", "Analyze one function and report its behavior.", ["address"]],
  ["get_call_graph", "Build the call graph of the whole binary.", []],
  ["read_memory", "Read memory at an address from the running process.", ["address", "length"]],
  ["debug_attach", "Attach the debugger to a running process.", ["pid"]]
];

// windows 的裸工具名是驼峰（Screenshot / DisplayInventory），与 mobile 的
// snake_case 混在一起，正好顺带验证驼峰拆词这条路径。
const WINDOWS_TOOLS = [
  ["Screenshot", "Take a screenshot of the desktop.", ["path"]],
  ["FileSystem", "Read and write files on the desktop.", ["mode", "path"]],
  ["Click", "Click the mouse at screen coordinates.", ["x", "y"]],
  ["Type", "Type text with the keyboard.", ["text"]],
  ["KeyPress", "Press a key combination on the keyboard.", ["key"]],
  ["DisplayInventory", "Read the active display layout and resolution.", []],
  ["ControlStatus", "Report the control status of the desktop.", []],
  ["ListWindows", "List the open windows on the desktop.", []],
  ["Clipboard", "Read or write the desktop clipboard.", ["text"]]
];

// openchatcut 的裸工具名无法从仓库里确证（面板上这台服务器常因 fetch failed
// 不在线），这里按「视频剪辑」这一域的常见动作拟名，仅用于评测分词与桥接
// （视频 / 剪辑 / 字幕 / 音频 / 导出）。真机对上一次名字后据此更新即可，
// 不影响本文件其余部分：每条查询都用 expectTool 校验，改名字只会红一条。
const OPENCHATCUT_TOOLS = [
  ["import_media", "Import a video file into the project.", ["path"]],
  ["list_media", "List the media assets imported in the project.", []],
  ["trim_clip", "Trim a clip to a time range.", ["clipId", "start", "end"]],
  ["split_clip", "Split a clip at a time point.", ["clipId", "at"]],
  ["list_clips", "List the clips on the timeline.", []],
  ["add_subtitle", "Add a subtitle item to the timeline.", ["text", "start", "end"]],
  ["remove_subtitle", "Remove a subtitle from the timeline.", ["id"]],
  ["add_audio_track", "Add an audio track to the project.", ["path"]],
  ["add_text_overlay", "Add a text overlay on top of the video.", ["text", "at"]],
  ["export_video", "Export the project to a video file.", ["path", "format"]]
];

const SERVERS = [
  ["mobile", MOBILE_TOOLS],
  ["rea", REA_TOOLS],
  ["windows", WINDOWS_TOOLS],
  ["openchatcut", OPENCHATCUT_TOOLS]
];

function entryOf(server, [tool, summary, params]) {
  return {
    name: "mcp__" + server + "__" + tool,
    server,
    tool,
    summary,
    parameters: {
      type: "object",
      properties: Object.fromEntries(params.map((p) => [p, { type: "string" }]))
    }
  };
}

// 目录快照：64 条工具，四台服务器。顺序固定（不依赖文件系统或网络），
// 这样同一条查询永远吃到同一份 idf。
export const CATALOG = SERVERS.flatMap(([server, tools]) => tools.map((t) => entryOf(server, t)));

// 任务句式。每条只断言「期望工具落在 top-3」，不断言名次顺序：
// 第一名该是谁在有多个合理候选时（手机上截图 vs 桌面上截图）本来就有争议，
// 门禁锁到名次会在无害的排序抖动上乱红，锁 top-3 才锁住真正要紧的事——
// 模型看得见正确的那个工具。
export const CORPUS = [
  // ── 中文：native / 反汇编 ────────────────────────────────
  { query: "反汇编这个函数", expectServer: "rea", expectTool: "disassemble_function" },
  { query: "列出二进制里的符号", expectServer: "rea", expectTool: "list_symbols" },
  { query: "这个地址属于哪个函数", expectServer: "rea", expectTool: "resolve_containing_procedure" },
  { query: "把函数反编译成伪代码", expectServer: "rea", expectTool: "decompile_function" },
  { query: "打开一个二进制文件分析", expectServer: "rea", expectTool: "open_binary" },
  { query: "对比源码和固件包是否一致", expectServer: "rea", expectTool: "compare_source_to_bundle" },
  { query: "谁引用了这个地址", expectServer: "rea", expectTool: "xrefs_to" },
  { query: "读一下进程里的内存", expectServer: "rea", expectTool: "read_memory" },
  { query: "把调试器挂到这个进程上", expectServer: "rea", expectTool: "debug_attach" },
  { query: "二进制里有哪些字符串", expectServer: "rea", expectTool: "list_strings" },
  { query: "画一下整个二进制的调用图", expectServer: "rea", expectTool: "get_call_graph" },
  { query: "反汇编 so 符号 调试", expectServer: "rea", expectTool: "disassemble_function" },

  // ── 中文：桌面 ──────────────────────────────────────────
  { query: "截屏下来", expectServer: "windows", expectTool: "Screenshot" },
  { query: "桌面截图保存到文件", expectServer: "windows", expectTool: "Screenshot" },
  { query: "用鼠标在坐标上点一下", expectServer: "windows", expectTool: "Click" },
  { query: "用键盘输入一段文字", expectServer: "windows", expectTool: "Type" },
  { query: "读一下桌面的剪贴板", expectServer: "windows", expectTool: "Clipboard" },
  { query: "列出当前打开的窗口", expectServer: "windows", expectTool: "ListWindows" },
  { query: "显示器的分辨率和布局", expectServer: "windows", expectTool: "DisplayInventory" },
  { query: "读写桌面上的文件", expectServer: "windows", expectTool: "FileSystem" },
  { query: "按一下组合键", expectServer: "windows", expectTool: "KeyPress" },

  // ── 中文：手机设备 ──────────────────────────────────────
  { query: "启动微信", expectServer: "mobile", expectTool: "mobile_launch_app" },
  { query: "卸载这个应用", expectServer: "mobile", expectTool: "mobile_uninstall_app" },
  { query: "装一个 apk 到手机上", expectServer: "mobile", expectTool: "mobile_install_app" },
  { query: "把前台的应用杀掉", expectServer: "mobile", expectTool: "mobile_terminate_app" },
  { query: "在手机上滑动屏幕", expectServer: "mobile", expectTool: "mobile_swipe_on_screen" },
  { query: "在屏幕坐标上点击", expectServer: "mobile", expectTool: "mobile_click_on_screen_at_coordinates" },
  { query: "列出屏幕上的元素", expectServer: "mobile", expectTool: "mobile_list_elements_on_screen" },
  { query: "打开一个网址", expectServer: "mobile", expectTool: "mobile_open_url" },
  { query: "拿设备的日志", expectServer: "mobile", expectTool: "mobile_get_device_logs" },
  { query: "列出崩溃记录", expectServer: "mobile", expectTool: "mobile_list_crashes" },
  { query: "进游戏卡死了拿崩溃栈", expectServer: "mobile", expectTool: "mobile_get_crash" },
  { query: "开始录屏", expectServer: "mobile", expectTool: "mobile_start_screen_recording" },
  { query: "屏幕旋转成横屏", expectServer: "mobile", expectTool: "mobile_set_orientation" },
  { query: "分配一台云手机", expectServer: "mobile", expectTool: "mobile_allocate_remote_device" },
  { query: "释放远程设备", expectServer: "mobile", expectTool: "mobile_release_remote_device" },
  { query: "现在有哪些可用的设备", expectServer: "mobile", expectTool: "mobile_list_available_devices" },
  { query: "当前前台是哪个应用", expectServer: "mobile", expectTool: "mobile_get_foreground_app" },
  { query: "列出手机已安装的应用", expectServer: "mobile", expectTool: "mobile_list_apps" },
  { query: "手机截屏存成文件", expectServer: "mobile", expectTool: "mobile_save_screenshot" },
  { query: "长按屏幕上的控件", expectServer: "mobile", expectTool: "mobile_long_press_on_screen_at_coordinates" },
  { query: "设一个模拟定位", expectServer: "mobile", expectTool: "mobile_set_location" },

  // ── 中文：视频剪辑 ──────────────────────────────────────
  { query: "导入视频素材", expectServer: "openchatcut", expectTool: "import_media" },
  { query: "裁剪片段的时间范围", expectServer: "openchatcut", expectTool: "trim_clip" },
  { query: "加一条字幕", expectServer: "openchatcut", expectTool: "add_subtitle" },
  { query: "导出成视频文件", expectServer: "openchatcut", expectTool: "export_video" },
  { query: "加一条音频轨道", expectServer: "openchatcut", expectTool: "add_audio_track" },
  { query: "在视频上叠文字", expectServer: "openchatcut", expectTool: "add_text_overlay" },

  // ── 英文：native ────────────────────────────────────────
  { query: "disassemble the function at this address", expectServer: "rea", expectTool: "disassemble_function" },
  { query: "list the symbols in the binary", expectServer: "rea", expectTool: "list_symbols" },
  { query: "which function contains this address", expectServer: "rea", expectTool: "resolve_containing_procedure" },
  { query: "decompile this function to pseudocode", expectServer: "rea", expectTool: "decompile_function" },
  { query: "open a binary for analysis", expectServer: "rea", expectTool: "open_binary" },
  { query: "compare the source tree to the firmware bundle", expectServer: "rea", expectTool: "compare_source_to_bundle" },
  { query: "find cross references to this address", expectServer: "rea", expectTool: "xrefs_to" },
  { query: "read memory from the running process", expectServer: "rea", expectTool: "read_memory" },
  { query: "attach the debugger to a process", expectServer: "rea", expectTool: "debug_attach" },
  { query: "list strings in the binary", expectServer: "rea", expectTool: "list_strings" },
  { query: "build the call graph", expectServer: "rea", expectTool: "get_call_graph" },

  // ── 英文：桌面 ──────────────────────────────────────────
  { query: "take a screenshot", expectServer: "windows", expectTool: "Screenshot" },
  { query: "screenshot the desktop and save it", expectServer: "windows", expectTool: "Screenshot" },
  { query: "click at these coordinates on the desktop", expectServer: "windows", expectTool: "Click" },
  { query: "type text with the keyboard", expectServer: "windows", expectTool: "Type" },
  { query: "press a key combination", expectServer: "windows", expectTool: "KeyPress" },
  { query: "read the clipboard", expectServer: "windows", expectTool: "Clipboard" },
  { query: "list the open windows", expectServer: "windows", expectTool: "ListWindows" },
  { query: "show the display inventory", expectServer: "windows", expectTool: "DisplayInventory" },
  { query: "read and write files on the desktop", expectServer: "windows", expectTool: "FileSystem" },

  // ── 英文：手机设备 ──────────────────────────────────────
  { query: "launch an app on the phone", expectServer: "mobile", expectTool: "mobile_launch_app" },
  { query: "uninstall the app from the device", expectServer: "mobile", expectTool: "mobile_uninstall_app" },
  { query: "install an apk on the device", expectServer: "mobile", expectTool: "mobile_install_app" },
  { query: "terminate the running app", expectServer: "mobile", expectTool: "mobile_terminate_app" },
  { query: "swipe on the device screen", expectServer: "mobile", expectTool: "mobile_swipe_on_screen" },
  { query: "take a screenshot of the mobile screen", expectServer: "mobile", expectTool: "mobile_take_screenshot" },
  { query: "save a screenshot of the device to a file", expectServer: "mobile", expectTool: "mobile_save_screenshot" },
  { query: "list elements on the device screen", expectServer: "mobile", expectTool: "mobile_list_elements_on_screen" },
  { query: "open a url in the device browser", expectServer: "mobile", expectTool: "mobile_open_url" },
  { query: "read the logcat logs from the device", expectServer: "mobile", expectTool: "mobile_get_device_logs" },
  { query: "list crash reports from the device", expectServer: "mobile", expectTool: "mobile_list_crashes" },
  { query: "get the crash stack trace", expectServer: "mobile", expectTool: "mobile_get_crash" },
  { query: "start screen recording", expectServer: "mobile", expectTool: "mobile_start_screen_recording" },
  { query: "set the device orientation", expectServer: "mobile", expectTool: "mobile_set_orientation" },
  { query: "allocate a remote cloud device", expectServer: "mobile", expectTool: "mobile_allocate_remote_device" },
  { query: "release the remote device", expectServer: "mobile", expectTool: "mobile_release_remote_device" },
  { query: "list available devices", expectServer: "mobile", expectTool: "mobile_list_available_devices" },
  { query: "get the foreground app", expectServer: "mobile", expectTool: "mobile_get_foreground_app" },
  { query: "list installed apps", expectServer: "mobile", expectTool: "mobile_list_apps" },

  // ── 英文：视频剪辑 ──────────────────────────────────────
  { query: "import a video file", expectServer: "openchatcut", expectTool: "import_media" },
  { query: "trim the clip to a time range", expectServer: "openchatcut", expectTool: "trim_clip" },
  { query: "add a subtitle", expectServer: "openchatcut", expectTool: "add_subtitle" },
  { query: "export the project as a video", expectServer: "openchatcut", expectTool: "export_video" },
  { query: "add an audio track", expectServer: "openchatcut", expectTool: "add_audio_track" },
  { query: "add a text overlay on the video", expectServer: "openchatcut", expectTool: "add_text_overlay" },

  // ── 留出组：更口语的说法 ────────────────────────────────
  // 这一组是在桥接表第一版定稿**之后**才写进来的，写的时候没有回头去补词表。
  // 为什么非要留一组：前面那批样例的 miss 我是逐条看着改的，改完 recall 变成
  // 1.000——那说明前一批已经被词表「训练」过，它对未见说法的泛化能力是未知的。
  //
  // 留出组测出的实况（写进注释是为了让后来的人知道这组样例是干嘛的）：
  //   · 修掉了三个真缺陷：桥接表里「引用」这一组居然没列「引用」本身，
  //     「分辨率」「布局」「模拟」也整个缺组，于是「被谁引用过」零命中；
  //     「剪掉 / 剪切」「片子」这类口语动词也没有对应词。
  //   · 剩下两条（删掉 / 移除 指卸载）按**设计**不补：给一个动作换个动词就说
  //     「删掉」，已经超出同义词表能覆盖的范围，硬塞进 uninstall 组会连带把
  //     「删掉这个文件」误导向卸应用。这类只剩语义层能解（见 README 的后续方向），
  //     不该靠对着这两条样例加词来消灭——那只是把过拟合藏进词表里。
  // 结论：这组样例保持不补词，它同时是「还能测出问题」的证据。
  { query: "把屏幕录下来存成视频", expectServer: "mobile", expectTool: "mobile_start_screen_recording" },
  { query: "删掉设备上装的那个应用", expectServer: "mobile", expectTool: "mobile_uninstall_app" },
  { query: "这个应用我不想要了从手机移除", expectServer: "mobile", expectTool: "mobile_uninstall_app" },
  { query: "这段二进制被谁引用过", expectServer: "rea", expectTool: "xrefs_to" },
  { query: "桌面现在是什么分辨率", expectServer: "windows", expectTool: "DisplayInventory" },
  { query: "手机刚刚闪退了帮我查崩溃记录", expectServer: "mobile", expectTool: "mobile_list_crashes" },
  { query: "把这条片子的开头剪掉", expectServer: "openchatcut", expectTool: "trim_clip" }
];

// 语料的自我约束：门禁测试会先断言这两条，免得有人靠删样例把 recall 刷上去。
export const CORPUS_MIN = 50;
export const CORPUS_MAX = 100;

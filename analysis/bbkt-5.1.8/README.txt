宝宝课堂 5.1.8 当贝版 APK：静态反编译分析
分析日期：2026-10-10

结论
已完成当前 APK 的静态资源解码及 Java 结构导出。可以查看页面布局、
图片、组件名称、方法签名、数据字段与接口声明，可作为类似电视应用的设计参考。
未恢复受保护的核心方法实现；这里的 Java 文件不是可直接编译运行的完整源码。
没有安装或运行原应用，没有请求原服务端，也没有绕过激活、会员或内容授权。

输入与身份
原文件：/Users/binwang/Working/易福门/email/bbkt_5.1.8_dangbei.apk
用户提供的目录文字存在乱码，以上为实际找到的路径。
大小：21,356,554 字节
SHA-256：88b6d8272f4b95d476499a6daff49d383212fbea51388d393de34f640bbb2067
包名：com.bbketang.app
应用名：宝宝课堂
版本：5.1.8 / versionCode 518
最低 Android API：21（Android 5.0）
目标 Android API：35；编译 API：35
Manifest 声明电视 Leanback 启动入口、触屏非必需，主要页面为横屏。
原生库架构：arm64-v8a、armeabi-v7a；加固加载器另含 x86/x86_64。

文件入口（相对于本报告所在目录）
apktool/AndroidManifest.xml：解码后的应用配置、权限和 Activity 清单
apktool/res/layout/activity_main.xml：首页布局
apktool/res/layout/fragment_category.xml：分类页面布局
apktool/res/layout/fragment_special.xml：专题页面布局
apktool/res/layout/activity_video_player.xml：播放器布局
apktool/res/layout/activity_settings.xml：设置布局
apktool/res/：解码后的全部资源，含其他分辨率/API 版本布局
jadx/sources/com/bbketang/app/：应用自身的 Java 结构导出
jadx/sources/com/bbketang/app/network/ApiService.java：15 个接口声明
jadx/sources/com/bbketang/app/network/model/：数据模型及字段
jadx/sources/com/bbketang/app/player/：播放器抽象及实现类结构
jadx/sources/com/bbketang/app/utils/TvRecyclerView.java：电视焦点处理类结构
api-reference.json：机器可读的接口声明清单，未实际调用
layout-reference.json：19 个主要布局入口及布局内的固定文本
inspection.json：APK 哈希、大小和 DEX 基本统计
app-method-coverage.json：原始 DEX 中应用类的方法定义统计
method-bytecode-summary.json：核心方法的原始字节码证据
archive-files.txt、*.classes.txt、*.urls.txt：原 APK 文件及静态类/URL 清单
apktool.log、jadx.log：工具执行记录

已提取的规模
4 个 DEX，共 13,756 个类定义；其中应用包下有 209 个类定义。
JADX 生成 6,169 个 Java 文件，其中应用包下 128 个，部分内部类合并到外部类文件。
资源解码输出 1,503 个资源文件，其中布局 XML 为 257 个，包含 SDK 和不同配置版本。
19 个主要应用布局入口；原 APK 中有 361 个 PNG 资源。
未发现 mp4、m3u8、mp3、webm、avi 格式的内置课程文件。

加固及还原范围
发现 assets/ijiami.ajm、assets/ijm_lib/*/libexec.so 与 s.h.e.l.l.* 加载器。
这些文件名具有爱加密加固特征，Manifest 的 Application 也指向该加载器。
应用类中 1,024 个方法定义：980 个有 code_item，44 个为抽象方法。
“有 code_item”不代表原实现仍在静态 DEX 内：例如 MainActivity.onCreate、
loadCategoriesFromBackend、VideoPlayerActivity.playVideo 的指令区以 return-void
开头，随后为空指令；onKeyDown 则以返回 false 的指令开头。
JADX 中相应方法显示空体、return null 或 return false，不代表原应用实际行为。
方法体被替换为空实现、结合加固加载器的证据，表明原实现受运行时保护。
本次未进行运行时解密或脱壳，受保护方法无法仅从这些静态输出还原。
JADX 以状态码 3 结束，报告 3,207 个错误计数；这是全包统计，不能等同于
应用中有 3,207 个失败方法。应用输出有 935 处警告、12 处 Method not decompiled 标记。
Apktool 资源解码以状态码 0 完成。
已验证 1,139 个解码后的 XML 文件均可解析，4 个保留 DEX 与原 APK 内容哈希一致。
apktool/original/AndroidManifest.xml 是保留的原始二进制 XML，不属于可读 XML 输出。
后端实现、数据库、完整课程和运营数据不会因反编译客户端而自动得到。

可确认的结构及参考价值
Manifest：启动/初始化、首页、播放器、设置、内置浏览器等 Activity。
布局与类名：首页使用 TabLayout + ViewPager，分类/专题使用卡片列表，具有
焦点样式与上下左右导航配置；实际导航行为仍需运行观察才能确认。
播放器类：PlayerEngine、TencentVodPlayerEngine、ExoPlayerEngine、
FallbackPlayerEngine。可确认腾讯点播和 ExoPlayer 两套类的存在；回退条件与
执行次序未恢复，不应只凭类名或常量认定真实播放流程。
播放器布局与模型：选集、倍速、字幕选项；模型含 videoUrl、srtEnUrl、
srtCnEnUrl 字段，体现视频及英文/双语字幕的数据结构。
设置布局固定文字：返回、登录、历史、关于。
接口声明：分类、视频列表、选集、推荐、观看历史、用户配置、设备记录、
激活、短信登录/退出、版本检查等；15 个接口中 14 个标有自定义 @Encrypt 注解。
接口路径及字段可帮助设计自己的 API，但本次没有验证请求参数、服务端响应、
加密协议或接口可用性，不能把声明当作可直接调用的完整协议。

开发类似应用时
当前资料足以作为页面结构和数据模型的参考，需要重写播放、遥控器导航、
状态管理与网络层，并提供自己的服务端和可使用的课程内容。
需要核对真实的动效、焦点移动、播放控制和页面切换时，应进一步运行观察应用。
本目录没有创建新 Android 工程，也没有编译或部署类似应用。

工具与判断分工
JADX 1.5.6：Java 结构导出；https://github.com/skylot/jadx
Apktool 3.0.3：Manifest 和资源解码。
Java 使用本机 DataGrip 自带 JBR 25；工具 JAR 位于 /private/tmp/bbkt-decompiler-tools/。
Homebrew 下载工具后，已停止依赖安装，未继续安装额外 Java 及升级系统库。
哈希、归档、DEX 计数、XML 和接口提取由确定性代码完成，限制与结构分析由 Codex 完成。
Jev usage: Not used。本次没有需要单独委托给 Jev 的候选筛选或语义分类步骤。

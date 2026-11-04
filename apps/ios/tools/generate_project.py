#!/usr/bin/env python3
"""Generate the dependency-free Xcode project; no XcodeGen installation needed."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
objects = {}
def key(name):
    return hashlib.sha1(name.encode()).hexdigest()[:24].upper()
def add(name, body):
    identifier = key(name)
    objects[identifier] = body
    return identifier
def q(value):
    return json.dumps(str(value))
def array(values):
    return '(' + ', '.join(values) + ',)'

files = sorted((root / 'MollyTime').rglob('*.swift'))
refs, builds = [], []
for file in files:
    path = file.relative_to(root).as_posix()
    ref = add(path, '{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ' + q(path) + '; sourceTree = SOURCE_ROOT;}')
    refs.append(ref)
    builds.append(add('build:' + path, '{isa = PBXBuildFile; fileRef = ' + ref + ';}'))
asset = add('assets', '{isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = MollyTime/Assets.xcassets; sourceTree = SOURCE_ROOT;}')
asset_build = add('build:assets', '{isa = PBXBuildFile; fileRef = ' + asset + ';}')
bundled = add('bundled-resources', '{isa = PBXFileReference; lastKnownFileType = folder; path = MollyTime/Resources/startup; sourceTree = SOURCE_ROOT;}')
bundled_build = add('build:bundled-resources', '{isa = PBXBuildFile; fileRef = ' + bundled + ';}')
info = add('info', '{isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = MollyTime/Info.plist; sourceTree = SOURCE_ROOT;}')
product = add('product', '{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = MollyTime.app; sourceTree = BUILT_PRODUCTS_DIR;}')
products = add('products', '{isa = PBXGroup; name = Products; children = ' + array([product]) + '; sourceTree = "<group>";}')
main = add('main', '{isa = PBXGroup; children = ' + array(refs + [asset, bundled, info, products]) + '; sourceTree = "<group>";}')
package = add('package', '{isa = XCLocalSwiftPackageReference; relativePath = ".";}')
core = add('core', '{isa = XCSwiftPackageProductDependency; package = ' + package + '; productName = MollyCore;}')
core_build = add('build:core', '{isa = PBXBuildFile; productRef = ' + core + ';}')
sources = add('sources', '{isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ' + array(builds) + '; runOnlyForDeploymentPostprocessing = 0;}')
resources = add('resources', '{isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ' + array([asset_build, bundled_build]) + '; runOnlyForDeploymentPostprocessing = 0;}')
frameworks = add('frameworks', '{isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ' + array([core_build]) + '; runOnlyForDeploymentPostprocessing = 0;}')

def settings(values):
    return '{' + ''.join(k + ' = ' + q(v) + ';' for k, v in values.items()) + '}'
def configs(prefix, common):
    entries=[]
    for mode in ['Debug', 'Release']:
        values = dict(common)
        values.update({'SWIFT_OPTIMIZATION_LEVEL': '-Onone' if mode == 'Debug' else '-O',
                       'DEBUG_INFORMATION_FORMAT': 'dwarf' if mode == 'Debug' else 'dwarf-with-dsym'})
        if mode == 'Debug':
            values['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = 'DEBUG'
            values['ENABLE_TESTABILITY'] = 'YES'
        entries.append(add(prefix + mode, '{isa = XCBuildConfiguration; name = ' + mode + '; buildSettings = ' + settings(values) + ';}'))
    return add(prefix + 'configs', '{isa = XCConfigurationList; buildConfigurations = ' + array(entries) + '; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;}')
project_configs = configs('project', {'SDKROOT': 'iphoneos', 'IPHONEOS_DEPLOYMENT_TARGET': '17.0', 'CLANG_ENABLE_MODULES': 'YES', 'SWIFT_VERSION': '5.0'})
target_configs = configs('target', {'PRODUCT_BUNDLE_IDENTIFIER': 'app.mollytime.parent', 'PRODUCT_NAME': '$(TARGET_NAME)',
    'INFOPLIST_FILE': 'MollyTime/Info.plist', 'ASSETCATALOG_COMPILER_APPICON_NAME': 'AppIcon',
    'CODE_SIGN_STYLE': 'Automatic', 'MARKETING_VERSION': '0.1.0', 'CURRENT_PROJECT_VERSION': '1',
    'TARGETED_DEVICE_FAMILY': '1,2', 'SUPPORTED_PLATFORMS': 'iphoneos iphonesimulator',
    'SUPPORTS_MACCATALYST': 'NO', 'LD_RUNPATH_SEARCH_PATHS': '$(inherited) @executable_path/Frameworks',
    'GENERATE_INFOPLIST_FILE': 'NO', 'SWIFT_EMIT_LOC_STRINGS': 'YES'})
target = add('target', '{isa = PBXNativeTarget; name = MollyTime; productName = MollyTime; productType = "com.apple.product-type.application"; productReference = ' + product + '; buildConfigurationList = ' + target_configs + '; buildPhases = ' + array([sources, frameworks, resources]) + '; buildRules = (); dependencies = (); packageProductDependencies = ' + array([core]) + ';}')
project = add('project', '{isa = PBXProject; attributes = {BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 1600;}; buildConfigurationList = ' + project_configs + '; compatibilityVersion = "Xcode 15.0"; developmentRegion = zh_CN; knownRegions = (zh_CN, en, Base); mainGroup = ' + main + '; productRefGroup = ' + products + '; projectDirPath = ""; projectRoot = ""; packageReferences = ' + array([package]) + '; targets = ' + array([target]) + ';}')
directory = root / 'MollyTime.xcodeproj'
directory.mkdir(exist_ok=True)
(directory/'project.pbxproj').write_text('// !$*UTF8*$!\n{archiveVersion = 1; classes = {}; objectVersion = 60; objects = {\n' + '\n'.join(i + ' = ' + body + ';' for i,body in objects.items()) + '\n}; rootObject = ' + project + ';}\n')
scheme_dir = directory/'xcshareddata/xcschemes'
scheme_dir.mkdir(parents=True,exist_ok=True)
reference = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="MollyTime.app" BlueprintName="MollyTime" ReferencedContainer="container:MollyTime.xcodeproj"/>'
(scheme_dir/'MollyTime.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{reference}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables/></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
print(f'Generated Xcode project with {len(files)} Swift files and local MollyCore package.')

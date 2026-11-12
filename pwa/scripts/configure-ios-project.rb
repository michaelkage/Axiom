#!/usr/bin/env ruby
require "fileutils"
require "xcodeproj"

root = File.expand_path("../..", __dir__)
ios_root = File.join(root, "ios")
project_path = File.join(ios_root, "App", "App.xcodeproj")
abort "Run npx cap add ios before configuring the native project." unless File.directory?(project_path)

project = Xcodeproj::Project.open(project_path)
app_target = project.targets.find { |target| target.name == "App" }
abort "Capacitor App target was not found." unless app_target

app_dir = File.join(ios_root, "App", "App")
FileUtils.mkdir_p(app_dir)
FileUtils.cp(File.join(__dir__, "..", "ios-native", "AxiomIOSPlugin.swift"), File.join(app_dir, "AxiomIOSPlugin.swift"))
FileUtils.cp(File.join(__dir__, "..", "ios-native", "App.entitlements"), File.join(app_dir, "App.entitlements"))

app_group = project.main_group.find_subpath("App", true)
plugin_ref = app_group.files.find { |file| file.path == "AxiomIOSPlugin.swift" } || app_group.new_file("AxiomIOSPlugin.swift")
app_target.source_build_phase.add_file_reference(plugin_ref) unless app_target.source_build_phase.files_references.include?(plugin_ref)

view_controller = File.join(app_dir, "ViewController.swift")
abort "Capacitor ViewController.swift was not found." unless File.file?(view_controller)
source = File.read(view_controller)
unless source.include?("registerPluginInstance(AxiomIOSPlugin())")
  if source.match?(/class ViewController\s*:\s*CAPBridgeViewController\s*\{\s*\}/)
    source.sub!(/class ViewController\s*:\s*CAPBridgeViewController\s*\{\s*\}/, "class ViewController: CAPBridgeViewController {\n    override open func capacitorDidLoad() {\n        bridge?.registerPluginInstance(AxiomIOSPlugin())\n    }\n}")
  elsif source.match?(/class ViewController\s*:\s*CAPBridgeViewController\s*\{/)
    source.sub!(/class ViewController\s*:\s*CAPBridgeViewController\s*\{/, "\\0\n    override open func capacitorDidLoad() {\n        bridge?.registerPluginInstance(AxiomIOSPlugin())\n    }")
  else
    abort "Unexpected ViewController.swift shape; refusing to overwrite native customizations."
  end
  File.write(view_controller, source)
end

storyboards = Dir.glob(File.join(app_dir, "**", "*.storyboard"))
storyboards.each do |storyboard|
  content = File.read(storyboard)
  updated = content.gsub('customClass="CAPBridgeViewController" customModule="Capacitor"', 'customClass="ViewController" customModule="App"')
  File.write(storyboard, updated) if updated != content
end

share_dir = File.join(ios_root, "App", "AxiomShare")
FileUtils.mkdir_p(share_dir)
FileUtils.cp(File.join(__dir__, "..", "ios-native", "AxiomShareViewController.swift"), File.join(share_dir, "AxiomShareViewController.swift"))
FileUtils.cp(File.join(__dir__, "..", "ios-native", "Share-Info.plist"), File.join(share_dir, "Info.plist"))
FileUtils.cp(File.join(__dir__, "..", "ios-native", "Share.entitlements"), File.join(share_dir, "AxiomShare.entitlements"))

share_target = project.targets.find { |target| target.name == "AxiomShare" }
unless share_target
  share_target = project.new_target(:app_extension, "AxiomShare", :ios, "15.0")
end
share_group = project.main_group.find_subpath("AxiomShare", true)
share_ref = share_group.files.find { |file| file.path == "AxiomShareViewController.swift" } || share_group.new_file("AxiomShareViewController.swift")
share_target.source_build_phase.add_file_reference(share_ref) unless share_target.source_build_phase.files_references.include?(share_ref)

[app_target, share_target].each do |target|
  target.build_configurations.each do |config|
    settings = config.build_settings
    settings["SWIFT_VERSION"] = "5.0"
    settings["IPHONEOS_DEPLOYMENT_TARGET"] = "15.0"
    settings["CODE_SIGN_ENTITLEMENTS"] = target == app_target ? "App/App.entitlements" : "AxiomShare/AxiomShare.entitlements"
  end
end

share_target.build_configurations.each do |config|
  settings = config.build_settings
  settings["PRODUCT_BUNDLE_IDENTIFIER"] = "com.axiom.mobile.share"
  settings["INFOPLIST_FILE"] = "AxiomShare/Info.plist"
  settings["APPLICATION_EXTENSION_API_ONLY"] = "YES"
  settings["SKIP_INSTALL"] = "YES"
  settings["TARGETED_DEVICE_FAMILY"] = "1,2"
end

app_target.build_configurations.each do |config|
  settings = config.build_settings
  settings["PRODUCT_BUNDLE_IDENTIFIER"] = "com.axiom.mobile"
  settings["INFOPLIST_KEY_NSMicrophoneUsageDescription"] = "Axiom uses the microphone for voice dictation."
  settings["INFOPLIST_KEY_NSSpeechRecognitionUsageDescription"] = "Axiom converts your speech into editable prompt text."
end

app_target.add_dependency(share_target) unless app_target.dependencies.any? { |dependency| dependency.target == share_target }
embed_phase = app_target.copy_files_build_phases.find { |phase| phase.dst_subfolder_spec == "13" }
embed_phase ||= app_target.new_copy_files_build_phase("Embed App Extensions")
embed_phase.dst_subfolder_spec = "13"
unless embed_phase.files_references.include?(share_target.product_reference)
  build_file = embed_phase.add_file_reference(share_target.product_reference, true)
  build_file.settings = { "ATTRIBUTES" => ["CodeSignOnCopy", "RemoveHeadersOnCopy"] }
end

project.save
puts "Configured Axiom iOS app, Keychain/speech/document plugin, and Share Extension target."

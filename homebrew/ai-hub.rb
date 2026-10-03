cask "ai-hub" do
  version "1.42.1"

  if Hardware::CPU.arm?
    url "https://github.com/axiscoretech/ai-hub/releases/download/v#{version}/AI-Hub-#{version}-arm64.dmg"
    sha256 "92178d7717f2cf6c80773f5bd6649a41f2f4f40149482ba1b719a2b9a24f1e2d"
  else
    url "https://github.com/axiscoretech/ai-hub/releases/download/v#{version}/AI-Hub-#{version}.dmg"
    sha256 "e9dae3947d80d6226e88d5d0dbface833a9c1e3d776570425b10165eda55ee91"
  end

  name "AI Hub"
  desc "Desktop app unifying ChatGPT, Claude, Gemini and other AI services"
  homepage "https://github.com/axiscoretech/ai-hub"

  app "AI Hub.app"

  zap trash: [
    "~/Library/Application Support/AI Hub",
    "~/Library/Preferences/com.aihub.desktop.plist",
  ]
end

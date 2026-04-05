cask "ai-hub" do
  version "1.0.0"

  if Hardware::CPU.arm?
    url "https://github.com/axiscoretech/ai-hub/releases/download/v#{version}/AI.Hub-#{version}-arm64.dmg"
    sha256 "REPLACE_WITH_ARM64_SHA256"
  else
    url "https://github.com/axiscoretech/ai-hub/releases/download/v#{version}/AI.Hub-#{version}.dmg"
    sha256 "REPLACE_WITH_X64_SHA256"
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

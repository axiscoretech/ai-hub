cask "ai-hub" do
  version "1.2.0"

  if Hardware::CPU.arm?
    url "https://github.com/axiscoretech/ai-hub/releases/download/v#{version}/AI-Hub-#{version}-arm64.dmg"
    sha256 "a079264f2843d79059025372ce23310b2dc8eabee62ce4f7fffb644c9f54cf60"
  else
    url "https://github.com/axiscoretech/ai-hub/releases/download/v#{version}/AI-Hub-#{version}.dmg"
    sha256 "bdb5332401faefad2b01cf75a721c7b7ff86a214181c95e3150a7b452c6da942"
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

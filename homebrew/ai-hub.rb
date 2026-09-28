cask "ai-hub" do
  version "1.42.0"

  if Hardware::CPU.arm?
    url "https://github.com/axiscoretech/ai-hub/releases/download/v#{version}/AI-Hub-#{version}-arm64.dmg"
    sha256 "25e36265349320a3e2592f80f00ff8d93f6e8403be97850b98d5afd0b338f0a8"
  else
    url "https://github.com/axiscoretech/ai-hub/releases/download/v#{version}/AI-Hub-#{version}.dmg"
    sha256 "31c55d9fef6608fc13b6679989016c1f0ddfacadb7b85d9ad4c83f19c1962ab6"
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

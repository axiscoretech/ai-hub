cask "ai-hub" do
  version "1.2.1"

  if Hardware::CPU.arm?
    url "https://github.com/axiscoretech/ai-hub/releases/download/v#{version}/AI-Hub-#{version}-arm64.dmg"
    sha256 "06e590d0a8d55445f1f0b18cf11ce8f46e7f92ebab2f706768bf4e0a477cff79"
  else
    url "https://github.com/axiscoretech/ai-hub/releases/download/v#{version}/AI-Hub-#{version}.dmg"
    sha256 "69693bb40ce3dc28e2dbf0c7a91738f5f4346c01b1ad9cc9702139bf23d3e1f1"
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

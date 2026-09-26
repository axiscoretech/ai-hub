cask "ai-hub" do
  version "1.5.0"

  if Hardware::CPU.arm?
    url "https://github.com/axiscoretech/ai-hub/releases/download/v#{version}/AI-Hub-#{version}-arm64.dmg"
    sha256 "5fdf38c2f0bde946bcbad869941e2dcf819f71903317dbb81e398d3f30db627f"
  else
    url "https://github.com/axiscoretech/ai-hub/releases/download/v#{version}/AI-Hub-#{version}.dmg"
    sha256 "64c1450def9321525a6aea0a5c1387a4644d7b0dfac1d62409c7a98a4d0a6b71"
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

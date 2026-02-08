return {
  "NickvanDyke/opencode.nvim",
  dependencies = {
    -- specific version of snacks is often required for the picker UI
    "folke/snacks.nvim", 
  },
  config = function()
    -- 1. Plugin Configuration
    -- This controls the Neovim UI behavior. 
    -- The actual AI model/API keys are managed by the `opencode` CLI tool itself.
    ---@type opencode.Opts
    vim.g.opencode_opts = {
      -- Example settings (uncomment/tweak as needed):
      adapter = "snacks", -- Force using snacks for the UI
    }

    -- 2. Vital Neovim Options
    -- OpenCode changes files externally. This ensures Neovim reloads them automatically.
    vim.o.autoread = true

    -- 3. Keymaps
    local map = vim.keymap.set
    local oc = require("opencode")

    -- --- GROUP 1: Standard Commands ---
    -- Ask the AI about the current visual selection or file
    map({ "n", "x" }, "<C-a>", function() oc.ask("@this: ", { submit = true }) end, { desc = "AI: Ask OpenCode" })
    
    -- Execute the action/code provided by AI
    map({ "n", "x" }, "<C-x>", function() oc.select() end, { desc = "AI: Execute Action" })
    
    -- Toggle the chat window
    map({ "n", "t" }, "<C-.>", function() oc.toggle() end, { desc = "AI: Toggle Window" })


    -- --- GROUP 2: Context Management ---
    -- 'go' (Go OpenCode) - Adds standard range to context
    map({ "n", "x" }, "go", function() return oc.operator("@this ") end, { desc = "AI: Add range to context", expr = true })
    
    -- 'goo' (Go OpenCode Line) - Adds current line to context
    map("n", "goo", function() return oc.operator("@this ") .. "_" end, { desc = "AI: Add line to context", expr = true })


    -- --- GROUP 3: Navigation ---
    -- Scroll the AI window up/down without leaving your code
    map("n", "<S-C-u>", function() oc.command("session.half.page.up") end,   { desc = "AI: Scroll Up" })
    map("n", "<S-C-d>", function() oc.command("session.half.page.down") end, { desc = "AI: Scroll Down" })


    -- --- GROUP 4: Remapped Defaults (IMPORTANT) ---
    -- Since <C-a> and <C-x> are usually "Increment/Decrement Number" in Vim,
    -- the plugin author recommends remapping those features to + and -.
    map("n", "+", "<C-a>", { desc = "Increment number", noremap = true })
    map("n", "-", "<C-x>", { desc = "Decrement number", noremap = true })
  end,
}

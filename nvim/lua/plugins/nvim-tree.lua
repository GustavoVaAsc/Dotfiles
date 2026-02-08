return {
  'nvim-tree/nvim-tree.lua',
  version = '*',
  lazy = false,
  dependencies = {
    'nvim-tree/nvim-web-devicons', -- Optional, for file icons
  },
  config = function()
    -- set up nvim-tree
    require('nvim-tree').setup {}

    -- keymaps
    local keymap = vim.keymap
    keymap.set('n', '<C-n>', ':NvimTreeToggle<CR>', { desc = 'Toggle file explorer' })
    keymap.set('n', '<leader>ff', ':NvimTreeFindFile<CR>', { desc = 'Focus current file in explorer' })
  end
}


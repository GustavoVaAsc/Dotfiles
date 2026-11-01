return {
    "neovim/nvim-lspconfig",
    dependencies = {
        "williamboman/mason.nvim",
        "williamboman/mason-lspconfig.nvim",
        "hrsh7th/cmp-nvim-lsp",
    },
    config = function()
        local servers = {
            "lua_ls",        -- Lua
            "ts_ls",         -- TypeScript/JS
            "pyright",       -- Python
            "clangd",        -- C/C++
            "gopls",         -- Go
            "rust_analyzer", -- Rust
        }

        require("mason").setup()

        -- Per-server settings live in nvim/lsp/<server>.lua and are merged
        -- with nvim-lspconfig's defaults. Shared capabilities go here.
        vim.lsp.config("*", {
            capabilities = require("cmp_nvim_lsp").default_capabilities(),
        })

        -- mason-lspconfig installs the servers and is the single place that
        -- calls vim.lsp.enable() for them.
        require("mason-lspconfig").setup({
            ensure_installed = servers,
            automatic_enable = servers,
        })
    end,
}

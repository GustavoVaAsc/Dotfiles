return {
    "neovim/nvim-lspconfig",
    dependencies = {
        "williamboman/mason.nvim",
        "williamboman/mason-lspconfig.nvim",
        "hrsh7th/cmp-nvim-lsp",
    },
    config = function()
        -- 1. Setup Mason
        require("mason").setup()

        -- 2. Define the list of servers
        local servers = {
            "lua_ls",        -- Lua
            "ts_ls",         -- TypeScript/JS (formerly tsserver)
            "pyright",       -- Python
            "clangd",        -- C++
            "gopls",         -- Go
            "rust_analyzer"  -- Rust
        }

        -- 3. Setup Mason-LSPConfig
        -- We only use this to ensure binaries are installed. 
        -- We will handle the configuration manually in the loop below.
        require("mason-lspconfig").setup({
            ensure_installed = servers,
            automatic_installation = false, -- We handle enabling below
        })

        local capabilities = require('cmp_nvim_lsp').default_capabilities()

        -- 4. Loop through the servers and set them up via Native API
        for _, server in ipairs(servers) do
            local opts = {
                capabilities = capabilities,
            }

            -- Lua needs special settings for the "vim" global
            if server == "lua_ls" then
                opts.settings = {
                    Lua = {
                        diagnostics = { globals = { "vim" } },
                    },
                }
            end

            -- C++: Configure for GNU G++ competitive programming
            if server == "clangd" then
                opts.filetypes = { "c", "cpp" }
                opts.settings = {
                    clangd = {
                        fallbackEdition = "c++17",
                    },
                }
                opts.init_options = {
                    clangdFileStatuses = true,
                }
                opts.autostart = true
            end

            -- [CHANGED] Use the native Neovim 0.11+ API
            -- This registers the config and enables the server for relevant filetypes
            vim.lsp.config(server, opts)
            vim.lsp.enable(server)
        end
    end
}

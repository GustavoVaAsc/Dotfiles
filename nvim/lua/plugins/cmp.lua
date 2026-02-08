return {
    "hrsh7th/nvim-cmp",
    event = "InsertEnter", -- Load only when typing
    dependencies = {
        "hrsh7th/cmp-nvim-lsp",      -- LSP source for nvim-cmp
        "hrsh7th/cmp-buffer",        -- Buffer text source
        "hrsh7th/cmp-path",          -- File path source
        "L3MON4D3/LuaSnip",          -- Snippet engine
        "saadparwaiz1/cmp_luasnip",  -- Adapter for LuaSnip
	"windwp/nvim-autopairs",
    },
    config = function()
        local cmp = require("cmp")
        local luasnip = require("luasnip")
	local cmp_autopairs = require('nvim-autopairs.completion.cmp')
        cmp.event:on(
            'confirm_done',
            cmp_autopairs.on_confirm_done()
        )
        cmp.setup({
            snippet = {
                expand = function(args)
                    luasnip.lsp_expand(args.body) -- Required for LSP snippets
                end,
            },
            mapping = cmp.mapping.preset.insert({
                ["<C-k>"] = cmp.mapping.select_prev_item(), -- Up
                ["<C-j>"] = cmp.mapping.select_next_item(), -- Down
                ["<C-b>"] = cmp.mapping.scroll_docs(-4),
                ["<C-f>"] = cmp.mapping.scroll_docs(4),
                ["<C-Space>"] = cmp.mapping.complete(),     -- Force open menu
                ["<C-e>"] = cmp.mapping.abort(),            -- Close menu
                ["<CR>"] = cmp.mapping.confirm({ select = true }), -- Enter to confirm
            }),
            sources = cmp.config.sources({
                { name = "nvim_lsp" }, -- Prioritize LSP
                { name = "luasnip" },  -- Then snippets
                { name = "path" },     -- Then paths
            }, {
                { name = "buffer" },   -- Then buffer text
            }),
        })
    end,
}

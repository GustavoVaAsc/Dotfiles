return {
    "folke/trouble.nvim",
    cmd = "Trouble",
    opts = {},
    keys = {
        { "<leader>xx", "<cmd>Trouble diagnostics toggle<cr>", desc = "Diagnostics (Trouble)" },
        { "<leader>xX", "<cmd>Trouble diagnostics toggle filter.buf=0<cr>", desc = "Buffer diagnostics (Trouble)" },
        { "<leader>xs", "<cmd>Trouble symbols toggle focus=false<cr>", desc = "Symbols (Trouble)" },
        { "<leader>xr", "<cmd>Trouble lsp_references toggle focus=false<cr>", desc = "LSP references (Trouble)" },
        { "<leader>xl", "<cmd>Trouble loclist toggle<cr>", desc = "Location list (Trouble)" },
        { "<leader>xq", "<cmd>Trouble qflist toggle<cr>", desc = "Quickfix list (Trouble)" },
    },
}

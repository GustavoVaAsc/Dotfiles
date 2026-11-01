-- Personal clang-format style, used only when the project has no .clang-format.
local clang_style = "--style={BasedOnStyle: Google, IndentWidth: 4, SortIncludes: Never}"

return {
    "stevearc/conform.nvim",
    event = { "BufWritePre" },
    cmd = { "ConformInfo" },
    keys = {
        {
            "<leader>fm",
            function() require("conform").format({ async = true, lsp_format = "fallback" }) end,
            mode = { "n", "x" },
            desc = "Format buffer",
        },
    },
    init = function()
        vim.api.nvim_create_user_command("FormatDisable", function(args)
            if args.bang then
                vim.b.disable_autoformat = true
            else
                vim.g.disable_autoformat = true
            end
        end, { bang = true, desc = "Disable format on save (! = this buffer only)" })

        vim.api.nvim_create_user_command("FormatEnable", function()
            vim.b.disable_autoformat = false
            vim.g.disable_autoformat = false
        end, { desc = "Re-enable format on save" })
    end,
    opts = {
        formatters_by_ft = {
            lua = { "stylua" },
            c = { "clang-format" },
            cpp = { "clang-format" },
            python = { "ruff_format" },
            javascript = { "prettier" },
            javascriptreact = { "prettier" },
            typescript = { "prettier" },
            typescriptreact = { "prettier" },
            go = { "goimports", "gofmt", stop_after_first = true },
            rust = { "rustfmt" },
        },
        formatters = {
            ["clang-format"] = {
                prepend_args = function(_, ctx)
                    local found = vim.fs.find({ ".clang-format", "_clang-format" }, {
                        path = ctx.dirname,
                        upward = true,
                        stop = vim.uv.os_homedir(),
                    })
                    if #found > 0 then
                        return {}
                    end
                    return { clang_style }
                end,
            },
        },
        -- Missing binaries are skipped by conform; the LSP formatter is used instead.
        format_on_save = function(bufnr)
            if vim.g.disable_autoformat or vim.b[bufnr].disable_autoformat then
                return
            end
            return { timeout_ms = 1000, lsp_format = "fallback" }
        end,
    },
}

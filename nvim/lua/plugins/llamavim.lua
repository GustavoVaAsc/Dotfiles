return {
    'ggml-org/llama.vim',
    init = function()
        -- Use the 'init' function to set variables BEFORE the plugin loads
        vim.g.llama_config = { 
	    endpoint = 'http://localhost:8080/infill',
	    show_info = 0,      -- 0 to disable info buffer, 1 to enable
            auto_fim = true,   -- Disable auto fill-in-the-middle if you want manual triggers only
            --keymap_accept_full = "<C-y>", -- Optional: Custom key to accept suggestion
        }
    end
}

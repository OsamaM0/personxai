// Generated via Supabase MCP generate_typescript_types (project personxai) — regenerate after
// each migration batch. Hand-written aliases are at the bottom.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.17"
  }
  public: {
    Tables: {
      agent_runs: {
        Row: {
          completion_tokens: number | null
          conversation_id: string | null
          cost_usd: number | null
          created_at: string
          error: string | null
          id: string
          iterations: number
          latency_ms: number | null
          model: string | null
          prompt_tokens: number | null
          status: Database["public"]["Enums"]["run_status"]
          tool_call_count: number
          trigger: Database["public"]["Enums"]["run_trigger"]
          user_id: string
        }
        Insert: {
          completion_tokens?: number | null
          conversation_id?: string | null
          cost_usd?: number | null
          created_at?: string
          error?: string | null
          id?: string
          iterations?: number
          latency_ms?: number | null
          model?: string | null
          prompt_tokens?: number | null
          status: Database["public"]["Enums"]["run_status"]
          tool_call_count?: number
          trigger: Database["public"]["Enums"]["run_trigger"]
          user_id: string
        }
        Update: {
          completion_tokens?: number | null
          conversation_id?: string | null
          cost_usd?: number | null
          created_at?: string
          error?: string | null
          id?: string
          iterations?: number
          latency_ms?: number | null
          model?: string | null
          prompt_tokens?: number | null
          status?: Database["public"]["Enums"]["run_status"]
          tool_call_count?: number
          trigger?: Database["public"]["Enums"]["run_trigger"]
          user_id?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          actor: Database["public"]["Enums"]["actor_kind"]
          created_at: string
          details: Json
          entity_id: string | null
          entity_kind: Database["public"]["Enums"]["entity_kind"] | null
          id: string
          status: string
          user_id: string | null
        }
        Insert: {
          action: string
          actor: Database["public"]["Enums"]["actor_kind"]
          created_at?: string
          details?: Json
          entity_id?: string | null
          entity_kind?: Database["public"]["Enums"]["entity_kind"] | null
          id?: string
          status?: string
          user_id?: string | null
        }
        Update: {
          action?: string
          actor?: Database["public"]["Enums"]["actor_kind"]
          created_at?: string
          details?: Json
          entity_id?: string | null
          entity_kind?: Database["public"]["Enums"]["entity_kind"] | null
          id?: string
          status?: string
          user_id?: string | null
        }
        Relationships: []
      }
      conversations: {
        Row: {
          archived_at: string | null
          created_at: string
          id: string
          is_active: boolean
          project_id: string | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          project_id?: string | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          project_id?: string | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      files: {
        Row: {
          caption: string | null
          created_at: string
          deleted_at: string | null
          embedding: string | null
          extracted_text: string | null
          extraction_status: Database["public"]["Enums"]["extraction_status"]
          file_name: string
          file_size: number | null
          id: string
          media_kind: string | null
          mime_type: string | null
          origin_chat_id: string | null
          origin_message_id: string | null
          project_id: string | null
          r2_key: string | null
          source: Database["public"]["Enums"]["file_source"]
          storage: Database["public"]["Enums"]["file_storage"]
          summary: string | null
          tags: string[]
          tg_file_id: string | null
          tg_file_unique_id: string | null
          updated_at: string
          user_id: string
          vault_chat_id: string | null
          vault_message_id: number | null
        }
        Insert: {
          caption?: string | null
          created_at?: string
          deleted_at?: string | null
          embedding?: string | null
          extracted_text?: string | null
          extraction_status?: Database["public"]["Enums"]["extraction_status"]
          file_name: string
          file_size?: number | null
          id?: string
          media_kind?: string | null
          mime_type?: string | null
          origin_chat_id?: string | null
          origin_message_id?: string | null
          project_id?: string | null
          r2_key?: string | null
          source?: Database["public"]["Enums"]["file_source"]
          storage?: Database["public"]["Enums"]["file_storage"]
          summary?: string | null
          tags?: string[]
          tg_file_id?: string | null
          tg_file_unique_id?: string | null
          updated_at?: string
          user_id: string
          vault_chat_id?: string | null
          vault_message_id?: number | null
        }
        Update: {
          caption?: string | null
          created_at?: string
          deleted_at?: string | null
          embedding?: string | null
          extracted_text?: string | null
          extraction_status?: Database["public"]["Enums"]["extraction_status"]
          file_name?: string
          file_size?: number | null
          id?: string
          media_kind?: string | null
          mime_type?: string | null
          origin_chat_id?: string | null
          origin_message_id?: string | null
          project_id?: string | null
          r2_key?: string | null
          source?: Database["public"]["Enums"]["file_source"]
          storage?: Database["public"]["Enums"]["file_storage"]
          summary?: string | null
          tags?: string[]
          tg_file_id?: string | null
          tg_file_unique_id?: string | null
          updated_at?: string
          user_id?: string
          vault_chat_id?: string | null
          vault_message_id?: number | null
        }
        Relationships: []
      }
      file_chunks: {
        Row: {
          chunk_index: number
          content: string
          created_at: string
          embedding: string | null
          file_id: string
          id: string
          user_id: string
        }
        Insert: {
          chunk_index: number
          content: string
          created_at?: string
          embedding?: string | null
          file_id: string
          id?: string
          user_id: string
        }
        Update: {
          chunk_index?: number
          content?: string
          created_at?: string
          embedding?: string | null
          file_id?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      file_tags: {
        Row: {
          file_id: string
          tag_id: string
        }
        Insert: {
          file_id: string
          tag_id: string
        }
        Update: {
          file_id?: string
          tag_id?: string
        }
        Relationships: []
      }
      skills: {
        Row: {
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          input_schema: Json | null
          instructions: string
          name: string
          permission_level: string
          tools: string[]
          triggers: Json
          updated_at: string
          user_id: string | null
          version: number
        }
        Insert: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          input_schema?: Json | null
          instructions: string
          name: string
          permission_level?: string
          tools?: string[]
          triggers?: Json
          updated_at?: string
          user_id?: string | null
          version?: number
        }
        Update: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          input_schema?: Json | null
          instructions?: string
          name?: string
          permission_level?: string
          tools?: string[]
          triggers?: Json
          updated_at?: string
          user_id?: string | null
          version?: number
        }
        Relationships: []
      }
      mcp_servers: {
        Row: {
          auth_header: string | null
          created_at: string
          enabled: boolean
          id: string
          last_connected_at: string | null
          last_error: string | null
          name: string
          updated_at: string
          url: string
          user_id: string
        }
        Insert: {
          auth_header?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          last_connected_at?: string | null
          last_error?: string | null
          name: string
          updated_at?: string
          url: string
          user_id: string
        }
        Update: {
          auth_header?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          last_connected_at?: string | null
          last_error?: string | null
          name?: string
          updated_at?: string
          url?: string
          user_id?: string
        }
        Relationships: []
      }
      system_prompts: {
        Row: {
          created_at: string
          created_by_role: Database["public"]["Enums"]["msg_role"]
          description: string | null
          id: string
          is_active: boolean
          prompt_content: string
          user_id: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by_role?: Database["public"]["Enums"]["msg_role"]
          description?: string | null
          id?: string
          is_active?: boolean
          prompt_content: string
          user_id: string
          version?: number
        }
        Update: {
          created_at?: string
          created_by_role?: Database["public"]["Enums"]["msg_role"]
          description?: string | null
          id?: string
          is_active?: boolean
          prompt_content?: string
          user_id?: string
          version?: number
        }
        Relationships: []
      }
      tags: {
        Row: {
          created_at: string
          id: string
          name: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          user_id?: string
        }
        Relationships: []
      }
      memories: {
        Row: {
          content: string
          created_at: string
          deleted_at: string | null
          embedding: string | null
          id: string
          importance: number
          last_accessed_at: string | null
          memory_type: Database["public"]["Enums"]["memory_type"]
          project_id: string | null
          source_message_id: string | null
          tags: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          deleted_at?: string | null
          embedding?: string | null
          id?: string
          importance?: number
          last_accessed_at?: string | null
          memory_type?: Database["public"]["Enums"]["memory_type"]
          project_id?: string | null
          source_message_id?: string | null
          tags?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          deleted_at?: string | null
          embedding?: string | null
          id?: string
          importance?: number
          last_accessed_at?: string | null
          memory_type?: Database["public"]["Enums"]["memory_type"]
          project_id?: string | null
          source_message_id?: string | null
          tags?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_facts: {
        Row: {
          category: string
          created_at: string
          id: string
          key: string
          updated_at: string
          user_id: string
          value: string
        }
        Insert: {
          category?: string
          created_at?: string
          id?: string
          key: string
          updated_at?: string
          user_id: string
          value: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          key?: string
          updated_at?: string
          user_id?: string
          value?: string
        }
        Relationships: []
      }
      links: {
        Row: {
          created_at: string
          deleted_at: string | null
          description: string | null
          embedding: string | null
          id: string
          project_id: string | null
          site_name: string | null
          summary: string | null
          tags: string[]
          title: string | null
          updated_at: string
          url: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          embedding?: string | null
          id?: string
          project_id?: string | null
          site_name?: string | null
          summary?: string | null
          tags?: string[]
          title?: string | null
          updated_at?: string
          url: string
          user_id: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          embedding?: string | null
          id?: string
          project_id?: string | null
          site_name?: string | null
          summary?: string | null
          tags?: string[]
          title?: string | null
          updated_at?: string
          url?: string
          user_id?: string
        }
        Relationships: []
      }
      inbox_items: {
        Row: {
          channel: string | null
          classification: Json | null
          created_at: string
          external_message_id: string | null
          id: string
          media: Json | null
          raw_content: string | null
          resolved_at: string | null
          resolved_entity_id: string | null
          resolved_kind: Database["public"]["Enums"]["entity_kind"] | null
          source: Database["public"]["Enums"]["inbox_source"]
          status: Database["public"]["Enums"]["inbox_status"]
          suggested_kind: Database["public"]["Enums"]["entity_kind"] | null
          suggested_project_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          channel?: string | null
          classification?: Json | null
          created_at?: string
          external_message_id?: string | null
          id?: string
          media?: Json | null
          raw_content?: string | null
          resolved_at?: string | null
          resolved_entity_id?: string | null
          resolved_kind?: Database["public"]["Enums"]["entity_kind"] | null
          source: Database["public"]["Enums"]["inbox_source"]
          status?: Database["public"]["Enums"]["inbox_status"]
          suggested_kind?: Database["public"]["Enums"]["entity_kind"] | null
          suggested_project_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          channel?: string | null
          classification?: Json | null
          created_at?: string
          external_message_id?: string | null
          id?: string
          media?: Json | null
          raw_content?: string | null
          resolved_at?: string | null
          resolved_entity_id?: string | null
          resolved_kind?: Database["public"]["Enums"]["entity_kind"] | null
          source?: Database["public"]["Enums"]["inbox_source"]
          status?: Database["public"]["Enums"]["inbox_status"]
          suggested_kind?: Database["public"]["Enums"]["entity_kind"] | null
          suggested_project_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      job_outbox: {
        Row: {
          attempts: number
          created_at: string
          delivered_at: string | null
          id: string
          idempotency_key: string
          in_flight_until: string | null
          last_error: string | null
          next_attempt_at: string
          occurrence_at: string
          reminder_id: string
          status: Database["public"]["Enums"]["job_status"]
          user_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          delivered_at?: string | null
          id?: string
          idempotency_key: string
          in_flight_until?: string | null
          last_error?: string | null
          next_attempt_at?: string
          occurrence_at: string
          reminder_id: string
          status?: Database["public"]["Enums"]["job_status"]
          user_id: string
        }
        Update: {
          attempts?: number
          created_at?: string
          delivered_at?: string | null
          id?: string
          idempotency_key?: string
          in_flight_until?: string | null
          last_error?: string | null
          next_attempt_at?: string
          occurrence_at?: string
          reminder_id?: string
          status?: Database["public"]["Enums"]["job_status"]
          user_id?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          channel: string | null
          content: string
          conversation_id: string
          created_at: string
          embedding: string | null
          external_message_id: string | null
          id: string
          media: Json | null
          role: Database["public"]["Enums"]["msg_role"]
          tokens_in: number | null
          tokens_out: number | null
          user_id: string
        }
        Insert: {
          channel?: string | null
          content: string
          conversation_id: string
          created_at?: string
          embedding?: string | null
          external_message_id?: string | null
          id?: string
          media?: Json | null
          role: Database["public"]["Enums"]["msg_role"]
          tokens_in?: number | null
          tokens_out?: number | null
          user_id: string
        }
        Update: {
          channel?: string | null
          content?: string
          conversation_id?: string
          created_at?: string
          embedding?: string | null
          external_message_id?: string | null
          id?: string
          media?: Json | null
          role?: Database["public"]["Enums"]["msg_role"]
          tokens_in?: number | null
          tokens_out?: number | null
          user_id?: string
        }
        Relationships: []
      }
      notes: {
        Row: {
          content: string
          created_at: string
          deleted_at: string | null
          embedding: string | null
          id: string
          pinned: boolean
          project_id: string | null
          source: Database["public"]["Enums"]["note_source"]
          tags: string[]
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          deleted_at?: string | null
          embedding?: string | null
          id?: string
          pinned?: boolean
          project_id?: string | null
          source?: Database["public"]["Enums"]["note_source"]
          tags?: string[]
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          deleted_at?: string | null
          embedding?: string | null
          id?: string
          pinned?: boolean
          project_id?: string | null
          source?: Database["public"]["Enums"]["note_source"]
          tags?: string[]
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      project_members: {
        Row: {
          created_at: string
          project_id: string
          role: Database["public"]["Enums"]["user_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          project_id: string
          role?: Database["public"]["Enums"]["user_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          project_id?: string
          role?: Database["public"]["Enums"]["user_role"]
          user_id?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          category: string | null
          created_at: string
          description: string | null
          due_date: string | null
          id: string
          name: string
          priority: Database["public"]["Enums"]["priority_level"]
          progress: number
          slug: string
          start_date: string | null
          status: Database["public"]["Enums"]["project_status"]
          tags: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          name: string
          priority?: Database["public"]["Enums"]["priority_level"]
          progress?: number
          slug: string
          start_date?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          tags?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          name?: string
          priority?: Database["public"]["Enums"]["priority_level"]
          progress?: number
          slug?: string
          start_date?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          tags?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      reminders: {
        Row: {
          content: string | null
          created_at: string
          deadline_at: string | null
          id: string
          kind: Database["public"]["Enums"]["reminder_kind"]
          linked_task_id: string | null
          next_trigger_at: string | null
          raw_text: string | null
          recurrence_rule: string | null
          start_at: string | null
          status: Database["public"]["Enums"]["reminder_status"]
          template_id: string | null
          template_params: Json | null
          timezone: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          deadline_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["reminder_kind"]
          linked_task_id?: string | null
          next_trigger_at?: string | null
          raw_text?: string | null
          recurrence_rule?: string | null
          start_at?: string | null
          status?: Database["public"]["Enums"]["reminder_status"]
          template_id?: string | null
          template_params?: Json | null
          timezone?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string | null
          created_at?: string
          deadline_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["reminder_kind"]
          linked_task_id?: string | null
          next_trigger_at?: string | null
          raw_text?: string | null
          recurrence_rule?: string | null
          start_at?: string | null
          status?: Database["public"]["Enums"]["reminder_status"]
          template_id?: string | null
          template_params?: Json | null
          timezone?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          key: string
          updated_at: string
          user_id: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          user_id: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          user_id?: string
          value?: Json
        }
        Relationships: []
      }
      task_dependencies: {
        Row: {
          created_at: string
          depends_on_task_id: string
          task_id: string
        }
        Insert: {
          created_at?: string
          depends_on_task_id: string
          task_id: string
        }
        Update: {
          created_at?: string
          depends_on_task_id?: string
          task_id?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          completed_at: string | null
          created_at: string
          description: string | null
          due_at: string | null
          id: string
          parent_task_id: string | null
          priority: Database["public"]["Enums"]["priority_level"]
          project_id: string | null
          recurrence_rule: string | null
          source: string
          start_at: string | null
          status: Database["public"]["Enums"]["task_status"]
          tags: string[]
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          description?: string | null
          due_at?: string | null
          id?: string
          parent_task_id?: string | null
          priority?: Database["public"]["Enums"]["priority_level"]
          project_id?: string | null
          recurrence_rule?: string | null
          source?: string
          start_at?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          tags?: string[]
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          description?: string | null
          due_at?: string | null
          id?: string
          parent_task_id?: string | null
          priority?: Database["public"]["Enums"]["priority_level"]
          project_id?: string | null
          recurrence_rule?: string | null
          source?: string
          start_at?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          tags?: string[]
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tool_calls: {
        Row: {
          args: Json | null
          created_at: string
          duration_ms: number | null
          error: string | null
          id: string
          result_summary: string | null
          run_id: string
          status: string
          tool_name: string
          user_id: string
        }
        Insert: {
          args?: Json | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          result_summary?: string | null
          run_id: string
          status: string
          tool_name: string
          user_id: string
        }
        Update: {
          args?: Json | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          result_summary?: string | null
          run_id?: string
          status?: string
          tool_name?: string
          user_id?: string
        }
        Relationships: []
      }
      user_identities: {
        Row: {
          channel: string
          chat_ref: string | null
          created_at: string
          external_id: string
          id: string
          user_id: string
          username: string | null
        }
        Insert: {
          channel: string
          chat_ref?: string | null
          created_at?: string
          external_id: string
          id?: string
          user_id: string
          username?: string | null
        }
        Update: {
          channel?: string
          chat_ref?: string | null
          created_at?: string
          external_id?: string
          id?: string
          user_id?: string
          username?: string | null
        }
        Relationships: []
      }
      users: {
        Row: {
          autonomy_level: number
          created_at: string
          display_name: string | null
          id: string
          is_allowed: boolean
          language: string
          last_seen_at: string | null
          role: Database["public"]["Enums"]["user_role"]
          timezone: string
          tz_confirmed: boolean
          updated_at: string
        }
        Insert: {
          autonomy_level?: number
          created_at?: string
          display_name?: string | null
          id?: string
          is_allowed?: boolean
          language?: string
          last_seen_at?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          timezone?: string
          tz_confirmed?: boolean
          updated_at?: string
        }
        Update: {
          autonomy_level?: number
          created_at?: string
          display_name?: string | null
          id?: string
          is_allowed?: boolean
          language?: string
          last_seen_at?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          timezone?: string
          tz_confirmed?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      vault_channels: {
        Row: {
          category: string | null
          chat_id: string
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          is_default: boolean
          last_synced_at: string | null
          tags: string[]
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          category?: string | null
          chat_id: string
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          is_default?: boolean
          last_synced_at?: string | null
          tags?: string[]
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string | null
          chat_id?: string
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          is_default?: boolean
          last_synced_at?: string | null
          tags?: string[]
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      wallet_entries: {
        Row: {
          amount: number
          category: string | null
          created_at: string
          currency: string
          deleted_at: string | null
          description: string
          direction: Database["public"]["Enums"]["wallet_direction"]
          id: string
          method: string | null
          note: string | null
          occurred_at: string
          project_id: string | null
          quantity: number | null
          source: string
          tags: string[]
          unit: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          category?: string | null
          created_at?: string
          currency?: string
          deleted_at?: string | null
          description: string
          direction: Database["public"]["Enums"]["wallet_direction"]
          id?: string
          method?: string | null
          note?: string | null
          occurred_at?: string
          project_id?: string | null
          quantity?: number | null
          source?: string
          tags?: string[]
          unit?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          category?: string | null
          created_at?: string
          currency?: string
          deleted_at?: string | null
          description?: string
          direction?: Database["public"]["Enums"]["wallet_direction"]
          id?: string
          method?: string | null
          note?: string | null
          occurred_at?: string
          project_id?: string | null
          quantity?: number | null
          source?: string
          tags?: string[]
          unit?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_due_jobs: {
        Args: { p_batch?: number }
        Returns: {
          attempts: number
          content: string
          job_id: string
          kind: Database["public"]["Enums"]["reminder_kind"]
          linked_task_id: string
          occurrence_at: string
          raw_text: string
          recurrence_rule: string
          reminder_id: string
          template_id: string
          template_params: Json
          timezone: string
          user_id: string
        }[]
      }
      hybrid_search: {
        Args: {
          p_user_id: string
          p_query: string
          p_query_embedding?: string | null
          p_kinds?: Database["public"]["Enums"]["entity_kind"][] | null
          p_limit?: number
        }
        Returns: {
          kind: Database["public"]["Enums"]["entity_kind"]
          id: string
          title: string
          snippet: string
          score: number
        }[]
      }
      match_memories: {
        Args: {
          p_user_id: string
          p_query_embedding: string
          p_project?: string | null
          p_tag_filter?: string[] | null
          p_limit?: number
        }
        Returns: {
          id: string
          content: string
          memory_type: Database["public"]["Enums"]["memory_type"]
          tags: string[]
          importance: number
          project_id: string | null
          similarity: number
        }[]
      }
      match_file_chunks: {
        Args: {
          p_user_id: string
          p_query_embedding: string
          p_project?: string | null
          p_limit?: number
        }
        Returns: {
          chunk_id: string
          file_id: string
          file_name: string
          chunk_index: number
          content: string
          similarity: number
        }[]
      }
      match_messages: {
        Args: {
          p_user_id: string
          p_conversation: string | null
          p_query_embedding: string
          p_limit?: number
        }
        Returns: {
          id: string
          role: Database["public"]["Enums"]["msg_role"]
          content: string
          created_at: string
          similarity: number
        }[]
      }
      match_notes: {
        Args: {
          p_user_id: string
          p_query_embedding: string
          p_project?: string | null
          p_limit?: number
        }
        Returns: {
          id: string
          title: string | null
          content: string
          tags: string[]
          similarity: number
        }[]
      }
      mark_job_delivered: { Args: { p_job_id: string }; Returns: undefined }
      mark_job_failed: {
        Args: { p_error: string; p_job_id: string }
        Returns: Database["public"]["Enums"]["job_status"]
      }
      select_due_reminders: { Args: never; Returns: number }
      tag_counts: {
        Args: { p_user_id: string }
        Returns: {
          name: string
          kind: Database["public"]["Enums"]["entity_kind"]
          count: number
        }[]
      }
      wallet_summary: {
        Args: { p_user_id: string; p_from?: string | null; p_to?: string | null }
        Returns: {
          currency: string
          money_in: number
          money_out: number
          net: number
          entries: number
        }[]
      }
      wallet_category_totals: {
        Args: {
          p_user_id: string
          p_direction?: Database["public"]["Enums"]["wallet_direction"] | null
          p_from?: string | null
          p_to?: string | null
          p_limit?: number
        }
        Returns: {
          category: string
          currency: string
          direction: Database["public"]["Enums"]["wallet_direction"]
          total: number
          entries: number
        }[]
      }
    }
    Enums: {
      actor_kind: "user" | "agent" | "system"
      extraction_status: "pending" | "done" | "failed" | "skipped"
      file_source: "telegram" | "generated"
      file_storage: "vault" | "r2"
      entity_kind:
        | "project"
        | "task"
        | "note"
        | "file"
        | "reminder"
        | "link"
        | "memory"
        | "inbox_item"
        | "skill"
        | "conversation"
        | "setting"
        | "user"
      inbox_source: "message" | "file" | "link" | "forward" | "voice" | "photo"
      inbox_status: "pending" | "organized" | "dismissed"
      job_status:
        | "pending"
        | "in_flight"
        | "delivered"
        | "failed"
        | "dead_letter"
      memory_type:
        | "preference"
        | "decision"
        | "project_context"
        | "fact"
        | "workflow"
        | "event"
      msg_role: "user" | "assistant" | "system" | "tool" | "system_routine_task"
      note_source: "manual" | "research" | "url" | "file" | "voice" | "agent"
      priority_level: "critical" | "high" | "medium" | "low"
      project_status:
        | "idea"
        | "planned"
        | "active"
        | "waiting"
        | "blocked"
        | "completed"
        | "archived"
      reminder_kind: "static" | "recurring" | "dynamic"
      reminder_status:
        | "scheduled"
        | "active"
        | "paused"
        | "completed"
        | "cancelled"
        | "failed"
      run_status: "ok" | "error" | "aborted"
      run_trigger:
        | "message"
        | "command"
        | "callback"
        | "schedule"
        | "heartbeat"
        | "daily_brief"
        | "dispatch"
      task_status:
        | "inbox"
        | "todo"
        | "in_progress"
        | "waiting"
        | "blocked"
        | "done"
        | "cancelled"
      user_role: "owner" | "admin" | "user" | "viewer"
      wallet_direction: "in" | "out"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

export const Constants = {
  public: {
    Enums: {
      actor_kind: ["user", "agent", "system"],
      extraction_status: ["pending", "done", "failed", "skipped"],
      file_source: ["telegram", "generated"],
      file_storage: ["vault", "r2"],
      entity_kind: [
        "project",
        "task",
        "note",
        "file",
        "reminder",
        "link",
        "memory",
        "inbox_item",
        "skill",
        "conversation",
        "setting",
        "user",
      ],
      inbox_source: ["message", "file", "link", "forward", "voice", "photo"],
      inbox_status: ["pending", "organized", "dismissed"],
      job_status: ["pending", "in_flight", "delivered", "failed", "dead_letter"],
      memory_type: [
        "preference",
        "decision",
        "project_context",
        "fact",
        "workflow",
        "event",
      ],
      msg_role: ["user", "assistant", "system", "tool", "system_routine_task"],
      note_source: ["manual", "research", "url", "file", "voice", "agent"],
      priority_level: ["critical", "high", "medium", "low"],
      project_status: [
        "idea",
        "planned",
        "active",
        "waiting",
        "blocked",
        "completed",
        "archived",
      ],
      reminder_kind: ["static", "recurring", "dynamic"],
      reminder_status: [
        "scheduled",
        "active",
        "paused",
        "completed",
        "cancelled",
        "failed",
      ],
      run_status: ["ok", "error", "aborted"],
      run_trigger: [
        "message",
        "command",
        "callback",
        "schedule",
        "heartbeat",
        "daily_brief",
        "dispatch",
      ],
      task_status: [
        "inbox",
        "todo",
        "in_progress",
        "waiting",
        "blocked",
        "done",
        "cancelled",
      ],
      user_role: ["owner", "admin", "user", "viewer"],
      wallet_direction: ["in", "out"],
    },
  },
} as const

// ── Hand-written convenience aliases ─────────────────────────────────────────

type PublicSchema = Database["public"]

export type Tables<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Row"]
export type TablesInsert<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Insert"]
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Update"]
export type Enums<T extends keyof PublicSchema["Enums"]> = PublicSchema["Enums"][T]

export type UserRow = Tables<"users">
export type UserIdentityRow = Tables<"user_identities">
export type SettingRow = Tables<"settings">
export type AuditLogRow = Tables<"audit_logs">
export type ConversationRow = Tables<"conversations">
export type MessageRow = Tables<"messages">
export type AgentRunRow = Tables<"agent_runs">
export type ToolCallRow = Tables<"tool_calls">
export type ProjectRow = Tables<"projects">
export type TaskRow = Tables<"tasks">
export type NoteRow = Tables<"notes">
export type InboxItemRow = Tables<"inbox_items">
export type ReminderRow = Tables<"reminders">
export type JobOutboxRow = Tables<"job_outbox">
export type FileRow = Tables<"files">
export type FileChunkRow = Tables<"file_chunks">
export type TagRow = Tables<"tags">
export type MemoryRow = Tables<"memories">
export type UserFactRow = Tables<"user_facts">
export type LinkRow = Tables<"links">
export type HybridHit = PublicSchema["Functions"]["hybrid_search"]["Returns"][number]
export type MemoryMatch = PublicSchema["Functions"]["match_memories"]["Returns"][number]
export type FileChunkMatch = PublicSchema["Functions"]["match_file_chunks"]["Returns"][number]
export type MessageMatch = PublicSchema["Functions"]["match_messages"]["Returns"][number]
export type SkillRow = Tables<"skills">
export type McpServerRow = Tables<"mcp_servers">
export type VaultChannelRow = Tables<"vault_channels">
export type TagCountRow = PublicSchema["Functions"]["tag_counts"]["Returns"][number]
export type WalletEntryRow = Tables<"wallet_entries">
export type WalletSummaryRow = PublicSchema["Functions"]["wallet_summary"]["Returns"][number]
export type WalletCategoryTotalRow =
  PublicSchema["Functions"]["wallet_category_totals"]["Returns"][number]
export type SystemPromptRow = Tables<"system_prompts">
export type ClaimedJob = PublicSchema["Functions"]["claim_due_jobs"]["Returns"][number]

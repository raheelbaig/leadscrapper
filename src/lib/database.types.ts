export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      api_call_log: {
        Row: {
          billable: boolean
          created_at: string
          duration_ms: number | null
          endpoint: string
          error: string | null
          http_status: number | null
          id: number
          page_index: number | null
          period: string
          result_count: number | null
          search_id: string | null
          sku: string
          tile_id: string | null
        }
        Insert: {
          billable?: boolean
          created_at?: string
          duration_ms?: number | null
          endpoint: string
          error?: string | null
          http_status?: number | null
          id?: number
          page_index?: number | null
          period: string
          result_count?: number | null
          search_id?: string | null
          sku: string
          tile_id?: string | null
        }
        Update: {
          billable?: boolean
          created_at?: string
          duration_ms?: number | null
          endpoint?: string
          error?: string | null
          http_status?: number | null
          id?: number
          page_index?: number | null
          period?: string
          result_count?: number | null
          search_id?: string | null
          sku?: string
          tile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "api_call_log_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_call_log_tile_id_fkey"
            columns: ["tile_id"]
            isOneToOne: false
            referencedRelation: "search_tiles"
            referencedColumns: ["id"]
          },
        ]
      }
      api_usage_counters: {
        Row: {
          calls: number
          period: string
          sku: string
          updated_at: string
        }
        Insert: {
          calls?: number
          period: string
          sku: string
          updated_at?: string
        }
        Update: {
          calls?: number
          period?: string
          sku?: string
          updated_at?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          created_at: string
          default_country: string | null
          default_state: string | null
          free_only: boolean
          grid_defaults: Json
          reserve_override: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          default_country?: string | null
          default_state?: string | null
          free_only?: boolean
          grid_defaults?: Json
          reserve_override?: Json | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          default_country?: string | null
          default_state?: string | null
          free_only?: boolean
          grid_defaults?: Json
          reserve_override?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      custom_areas: {
        Row: {
          area_km2: number | null
          base_location_id: string | null
          city: string | null
          country: string
          created_at: string
          id: string
          max_lat: number
          max_lng: number
          min_lat: number
          min_lng: number
          name: string
          notes: string | null
          state: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          area_km2?: number | null
          base_location_id?: string | null
          city?: string | null
          country: string
          created_at?: string
          id?: string
          max_lat: number
          max_lng: number
          min_lat: number
          min_lng: number
          name: string
          notes?: string | null
          state?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          area_km2?: number | null
          base_location_id?: string | null
          city?: string | null
          country?: string
          created_at?: string
          id?: string
          max_lat?: number
          max_lng?: number
          min_lat?: number
          min_lng?: number
          name?: string
          notes?: string | null
          state?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "custom_areas_base_location_id_fkey"
            columns: ["base_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      exports: {
        Row: {
          created_at: string
          error: string | null
          file_size: number | null
          filters: Json
          id: string
          kind: string
          label: string
          row_count: number | null
          search_id: string | null
          status: Database["public"]["Enums"]["export_status"]
          storage_path: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          file_size?: number | null
          filters?: Json
          id?: string
          kind?: string
          label: string
          row_count?: number | null
          search_id?: string | null
          status?: Database["public"]["Enums"]["export_status"]
          storage_path?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          error?: string | null
          file_size?: number | null
          filters?: Json
          id?: string
          kind?: string
          label?: string
          row_count?: number | null
          search_id?: string | null
          status?: Database["public"]["Enums"]["export_status"]
          storage_path?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exports_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_enrichment_attempts: {
        Row: {
          confidence: number | null
          cost_sku: string | null
          cost_units: number
          created_at: string
          duration_ms: number | null
          email: string | null
          error: string | null
          id: string
          lead_id: string
          provider: string
          raw: Json
          status: Database["public"]["Enums"]["email_status"]
          user_id: string
        }
        Insert: {
          confidence?: number | null
          cost_sku?: string | null
          cost_units?: number
          created_at?: string
          duration_ms?: number | null
          email?: string | null
          error?: string | null
          id?: string
          lead_id: string
          provider: string
          raw?: Json
          status: Database["public"]["Enums"]["email_status"]
          user_id: string
        }
        Update: {
          confidence?: number | null
          cost_sku?: string | null
          cost_units?: number
          created_at?: string
          duration_ms?: number | null
          email?: string | null
          error?: string | null
          id?: string
          lead_id?: string
          provider?: string
          raw?: Json
          status?: Database["public"]["Enums"]["email_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_enrichment_attempts_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          address: string | null
          city: string | null
          country: string | null
          created_at: string
          email: string | null
          email_checked_at: string | null
          email_confidence: number | null
          email_source: string | null
          email_status: Database["public"]["Enums"]["email_status"]
          id: string
          is_new_globally: boolean
          lat: number | null
          lng: number | null
          maps_url: string | null
          name: string
          phone_international: string | null
          phone_national: string | null
          place_id: string
          query_tile: string | null
          raw: Json
          search_id: string
          state: string | null
          tile_id: string | null
          updated_at: string
          user_id: string
          website: string | null
        }
        Insert: {
          address?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          email?: string | null
          email_checked_at?: string | null
          email_confidence?: number | null
          email_source?: string | null
          email_status?: Database["public"]["Enums"]["email_status"]
          id?: string
          is_new_globally?: boolean
          lat?: number | null
          lng?: number | null
          maps_url?: string | null
          name: string
          phone_international?: string | null
          phone_national?: string | null
          place_id: string
          query_tile?: string | null
          raw?: Json
          search_id: string
          state?: string | null
          tile_id?: string | null
          updated_at?: string
          user_id: string
          website?: string | null
        }
        Update: {
          address?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          email?: string | null
          email_checked_at?: string | null
          email_confidence?: number | null
          email_source?: string | null
          email_status?: Database["public"]["Enums"]["email_status"]
          id?: string
          is_new_globally?: boolean
          lat?: number | null
          lng?: number | null
          maps_url?: string | null
          name?: string
          phone_international?: string | null
          phone_national?: string | null
          place_id?: string
          query_tile?: string | null
          raw?: Json
          search_id?: string
          state?: string | null
          tile_id?: string | null
          updated_at?: string
          user_id?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_tile_id_fkey"
            columns: ["tile_id"]
            isOneToOne: false
            referencedRelation: "search_tiles"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          address_components: Json
          area_km2: number | null
          city: string
          country: string
          created_at: string
          formatted_address: string | null
          google_place_id: string | null
          height_km: number | null
          id: string
          label: string
          max_lat: number
          max_lng: number
          min_lat: number
          min_lng: number
          normalized_key: string | null
          resolved_at: string
          source: Database["public"]["Enums"]["bbox_source"]
          state: string | null
          updated_at: string
          width_km: number | null
        }
        Insert: {
          address_components?: Json
          area_km2?: number | null
          city: string
          country: string
          created_at?: string
          formatted_address?: string | null
          google_place_id?: string | null
          height_km?: number | null
          id?: string
          label: string
          max_lat: number
          max_lng: number
          min_lat: number
          min_lng: number
          normalized_key?: string | null
          resolved_at?: string
          source: Database["public"]["Enums"]["bbox_source"]
          state?: string | null
          updated_at?: string
          width_km?: number | null
        }
        Update: {
          address_components?: Json
          area_km2?: number | null
          city?: string
          country?: string
          created_at?: string
          formatted_address?: string | null
          google_place_id?: string | null
          height_km?: number | null
          id?: string
          label?: string
          max_lat?: number
          max_lng?: number
          min_lat?: number
          min_lng?: number
          normalized_key?: string | null
          resolved_at?: string
          source?: Database["public"]["Enums"]["bbox_source"]
          state?: string | null
          updated_at?: string
          width_km?: number | null
        }
        Relationships: []
      }
      places_seen: {
        Row: {
          first_search_id: string | null
          first_seen_at: string
          last_seen_at: string
          place_id: string
          times_seen: number
          user_id: string
        }
        Insert: {
          first_search_id?: string | null
          first_seen_at?: string
          last_seen_at?: string
          place_id: string
          times_seen?: number
          user_id: string
        }
        Update: {
          first_search_id?: string | null
          first_seen_at?: string
          last_seen_at?: string
          place_id?: string
          times_seen?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "places_seen_first_search_id_fkey"
            columns: ["first_search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
        ]
      }
      search_events: {
        Row: {
          code: string
          created_at: string
          id: number
          level: Database["public"]["Enums"]["event_level"]
          message: string
          meta: Json
          search_id: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: number
          level?: Database["public"]["Enums"]["event_level"]
          message: string
          meta?: Json
          search_id: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: number
          level?: Database["public"]["Enums"]["event_level"]
          message?: string
          meta?: Json
          search_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "search_events_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
        ]
      }
      search_tiles: {
        Row: {
          api_calls: number
          area_km2: number | null
          attempts: number
          completed_at: string | null
          created_at: string
          depth: number
          edge_km: number | null
          id: string
          label: string
          last_error: string | null
          last_reason: string | null
          max_lat: number
          max_lng: number
          min_lat: number
          min_lng: number
          next_page_token: string | null
          pages_fetched: number
          parent_tile_id: string | null
          path: string
          results_count: number
          search_id: string
          started_at: string | null
          state: Database["public"]["Enums"]["tile_state"]
          token_after_last: boolean
          unique_new_count: number
          updated_at: string
        }
        Insert: {
          api_calls?: number
          area_km2?: number | null
          attempts?: number
          completed_at?: string | null
          created_at?: string
          depth?: number
          edge_km?: number | null
          id?: string
          label: string
          last_error?: string | null
          last_reason?: string | null
          max_lat: number
          max_lng: number
          min_lat: number
          min_lng: number
          next_page_token?: string | null
          pages_fetched?: number
          parent_tile_id?: string | null
          path: string
          results_count?: number
          search_id: string
          started_at?: string | null
          state?: Database["public"]["Enums"]["tile_state"]
          token_after_last?: boolean
          unique_new_count?: number
          updated_at?: string
        }
        Update: {
          api_calls?: number
          area_km2?: number | null
          attempts?: number
          completed_at?: string | null
          created_at?: string
          depth?: number
          edge_km?: number | null
          id?: string
          label?: string
          last_error?: string | null
          last_reason?: string | null
          max_lat?: number
          max_lng?: number
          min_lat?: number
          min_lng?: number
          next_page_token?: string | null
          pages_fetched?: number
          parent_tile_id?: string | null
          path?: string
          results_count?: number
          search_id?: string
          started_at?: string | null
          state?: Database["public"]["Enums"]["tile_state"]
          token_after_last?: boolean
          unique_new_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "search_tiles_parent_tile_id_fkey"
            columns: ["parent_tile_id"]
            isOneToOne: false
            referencedRelation: "search_tiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_tiles_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
        ]
      }
      searches: {
        Row: {
          api_calls_run: number
          area_covered_km2: number
          area_total_km2: number
          city: string
          country: string
          coverage_pct: number
          coverage_report: Json | null
          created_at: string
          current_page: number | null
          current_tile_id: string | null
          custom_area_id: string | null
          field_mask: string[]
          finished_at: string | null
          grid_config: Json
          grid_key: string
          heartbeat_at: string | null
          id: string
          label: string
          last_error: string | null
          leads_found: number
          location_id: string | null
          locked_at: string | null
          locked_by: string | null
          max_lat: number
          max_lng: number
          min_lat: number
          min_lng: number
          niche: string
          pricing_version: string
          query_text: string
          queued_at: string | null
          search_sku: string
          started_at: string | null
          state: string | null
          status: Database["public"]["Enums"]["search_status"]
          status_text: string | null
          stop_reason: string | null
          target_leads: number
          tick_count: number
          tiles_covered: number
          tiles_empty: number
          tiles_failed: number
          tiles_in_progress: number
          tiles_pending: number
          tiles_saturated_floor: number
          tiles_skipped_quota: number
          tiles_subdivided: number
          tiles_total: number
          updated_at: string
          user_id: string
        }
        Insert: {
          api_calls_run?: number
          area_covered_km2?: number
          area_total_km2?: number
          city: string
          country: string
          coverage_pct?: number
          coverage_report?: Json | null
          created_at?: string
          current_page?: number | null
          current_tile_id?: string | null
          custom_area_id?: string | null
          field_mask: string[]
          finished_at?: string | null
          grid_config: Json
          grid_key: string
          heartbeat_at?: string | null
          id?: string
          label: string
          last_error?: string | null
          leads_found?: number
          location_id?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_lat: number
          max_lng: number
          min_lat: number
          min_lng: number
          niche: string
          pricing_version: string
          query_text: string
          queued_at?: string | null
          search_sku: string
          started_at?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["search_status"]
          status_text?: string | null
          stop_reason?: string | null
          target_leads: number
          tick_count?: number
          tiles_covered?: number
          tiles_empty?: number
          tiles_failed?: number
          tiles_in_progress?: number
          tiles_pending?: number
          tiles_saturated_floor?: number
          tiles_skipped_quota?: number
          tiles_subdivided?: number
          tiles_total?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          api_calls_run?: number
          area_covered_km2?: number
          area_total_km2?: number
          city?: string
          country?: string
          coverage_pct?: number
          coverage_report?: Json | null
          created_at?: string
          current_page?: number | null
          current_tile_id?: string | null
          custom_area_id?: string | null
          field_mask?: string[]
          finished_at?: string | null
          grid_config?: Json
          grid_key?: string
          heartbeat_at?: string | null
          id?: string
          label?: string
          last_error?: string | null
          leads_found?: number
          location_id?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_lat?: number
          max_lng?: number
          min_lat?: number
          min_lng?: number
          niche?: string
          pricing_version?: string
          query_text?: string
          queued_at?: string | null
          search_sku?: string
          started_at?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["search_status"]
          status_text?: string | null
          stop_reason?: string | null
          target_leads?: number
          tick_count?: number
          tiles_covered?: number
          tiles_empty?: number
          tiles_failed?: number
          tiles_in_progress?: number
          tiles_pending?: number
          tiles_saturated_floor?: number
          tiles_skipped_quota?: number
          tiles_subdivided?: number
          tiles_total?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "searches_custom_area_id_fkey"
            columns: ["custom_area_id"]
            isOneToOne: false
            referencedRelation: "custom_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "searches_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      tile_events: {
        Row: {
          created_at: string
          from_state: Database["public"]["Enums"]["tile_state"] | null
          id: number
          meta: Json
          reason: string | null
          search_id: string
          tile_id: string
          to_state: Database["public"]["Enums"]["tile_state"]
        }
        Insert: {
          created_at?: string
          from_state?: Database["public"]["Enums"]["tile_state"] | null
          id?: number
          meta?: Json
          reason?: string | null
          search_id: string
          tile_id: string
          to_state: Database["public"]["Enums"]["tile_state"]
        }
        Update: {
          created_at?: string
          from_state?: Database["public"]["Enums"]["tile_state"] | null
          id?: number
          meta?: Json
          reason?: string | null
          search_id?: string
          tile_id?: string
          to_state?: Database["public"]["Enums"]["tile_state"]
        }
        Relationships: [
          {
            foreignKeyName: "tile_events_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "searches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tile_events_tile_id_fkey"
            columns: ["tile_id"]
            isOneToOne: false
            referencedRelation: "search_tiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tile_state_transitions: {
        Row: {
          from_state: Database["public"]["Enums"]["tile_state"]
          note: string | null
          to_state: Database["public"]["Enums"]["tile_state"]
        }
        Insert: {
          from_state: Database["public"]["Enums"]["tile_state"]
          note?: string | null
          to_state: Database["public"]["Enums"]["tile_state"]
        }
        Update: {
          from_state?: Database["public"]["Enums"]["tile_state"]
          note?: string | null
          to_state?: Database["public"]["Enums"]["tile_state"]
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      billing_period: { Args: { p_tz: string }; Returns: string }
      claim_search_job: {
        Args: { p_lease_seconds?: number; p_worker: string }
        Returns: {
          api_calls_run: number
          area_covered_km2: number
          area_total_km2: number
          city: string
          country: string
          coverage_pct: number
          coverage_report: Json | null
          created_at: string
          current_page: number | null
          current_tile_id: string | null
          custom_area_id: string | null
          field_mask: string[]
          finished_at: string | null
          grid_config: Json
          grid_key: string
          heartbeat_at: string | null
          id: string
          label: string
          last_error: string | null
          leads_found: number
          location_id: string | null
          locked_at: string | null
          locked_by: string | null
          max_lat: number
          max_lng: number
          min_lat: number
          min_lng: number
          niche: string
          pricing_version: string
          query_text: string
          queued_at: string | null
          search_sku: string
          started_at: string | null
          state: string | null
          status: Database["public"]["Enums"]["search_status"]
          status_text: string | null
          stop_reason: string | null
          target_leads: number
          tick_count: number
          tiles_covered: number
          tiles_empty: number
          tiles_failed: number
          tiles_in_progress: number
          tiles_pending: number
          tiles_saturated_floor: number
          tiles_skipped_quota: number
          tiles_subdivided: number
          tiles_total: number
          updated_at: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "searches"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      create_child_tiles: {
        Args: { p_reason?: string; p_tile: string }
        Returns: number
      }
      enrichment_summary: {
        Args: { p_user: string }
        Returns: {
          enrichable: number
          failed: number
          found: number
          no_website: number
          not_enriched: number
          not_found: number
          queued: number
          total: number
          unverified: number
          verified: number
        }[]
      }
      heartbeat_job: {
        Args: {
          p_current_page?: number
          p_current_tile?: string
          p_search: string
          p_status_text?: string
          p_worker: string
        }
        Returns: boolean
      }
      insert_leads_dedup: {
        Args: { p_leads: Json; p_search: string; p_tile: string }
        Returns: {
          inserted: number
          received: number
        }[]
      }
      quota_snapshot: {
        Args: {
          p_free_limit: number
          p_reserve: number
          p_sku: string
          p_tz: string
        }
        Returns: {
          effective_limit: number
          free_limit: number
          period: string
          remaining: number
          reserve: number
          sku: string
          used: number
        }[]
      }
      recompute_search_progress: {
        Args: { p_search: string }
        Returns: undefined
      }
      record_api_call: {
        Args: {
          p_billable?: boolean
          p_duration_ms?: number
          p_endpoint: string
          p_error?: string
          p_http_status?: number
          p_page_index?: number
          p_result_count?: number
          p_search_id?: string
          p_sku: string
          p_tile_id?: string
          p_tz: string
        }
        Returns: number
      }
      recover_stalled_tiles: { Args: { p_search: string }; Returns: number }
      rect_area_km2: {
        Args: {
          p_max_lat: number
          p_max_lng: number
          p_min_lat: number
          p_min_lng: number
        }
        Returns: number
      }
      rect_height_km: {
        Args: { p_max_lat: number; p_min_lat: number }
        Returns: number
      }
      rect_width_km: {
        Args: {
          p_max_lat: number
          p_max_lng: number
          p_min_lat: number
          p_min_lng: number
        }
        Returns: number
      }
      release_api_calls: {
        Args: { p_n: number; p_sku: string; p_tz: string }
        Returns: number
      }
      release_job: {
        Args: {
          p_last_error?: string
          p_search: string
          p_status: Database["public"]["Enums"]["search_status"]
          p_stop_reason?: string
          p_worker: string
        }
        Returns: boolean
      }
      reserve_api_calls: {
        Args: {
          p_free_limit: number
          p_n: number
          p_reserve: number
          p_sku: string
          p_tz: string
        }
        Returns: {
          effective_limit: number
          granted: boolean
          period: string
          remaining: number
          used: number
        }[]
      }
      verify_search_coverage: { Args: { p_search: string }; Returns: Json }
    }
    Enums: {
      bbox_source: "cache" | "manual" | "geocoding" | "places" | "user_entered"
      email_status:
        | "not_enriched"
        | "queued"
        | "found"
        | "verified"
        | "unverified"
        | "not_found"
        | "failed"
      event_level: "info" | "warn" | "error"
      export_status: "pending" | "ready" | "failed"
      search_status:
        | "draft"
        | "queued"
        | "running"
        | "paused"
        | "completed"
        | "failed"
        | "canceled"
      tile_state:
        | "pending"
        | "in_progress"
        | "covered"
        | "empty"
        | "subdivided"
        | "saturated_floor"
        | "failed"
        | "skipped_quota"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      bbox_source: ["cache", "manual", "geocoding", "places", "user_entered"],
      email_status: [
        "not_enriched",
        "queued",
        "found",
        "verified",
        "unverified",
        "not_found",
        "failed",
      ],
      event_level: ["info", "warn", "error"],
      export_status: ["pending", "ready", "failed"],
      search_status: [
        "draft",
        "queued",
        "running",
        "paused",
        "completed",
        "failed",
        "canceled",
      ],
      tile_state: [
        "pending",
        "in_progress",
        "covered",
        "empty",
        "subdivided",
        "saturated_floor",
        "failed",
        "skipped_quota",
      ],
    },
  },
} as const
